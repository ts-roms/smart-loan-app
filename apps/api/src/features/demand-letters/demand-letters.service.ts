import {
  type AuditLogRepository,
  type DemandLetterRepository,
  type LoanRepository,
  type NotificationRepository,
  type PrismaClient,
} from "@loan/db";
import type { FastifyBaseLogger } from "fastify";

import type {
  ApproveInput,
  BatchInput,
  CloseInput,
  DemandLetterStageEnum,
  DispatchInput,
  ListQuery,
} from "./schemas";

/**
 * Demand-letter orchestration — FRD §3.6.
 *
 * The reason this earns a service:
 *   1. Approval is stage-gated (FRD §3.6.5 escalation matrix) AND
 *      enforces segregation-of-duties (drafter ≠ approver). That logic
 *      doesn't belong in the HTTP shell.
 *   2. Batch draft injects a per-loan penalty lookup into the repo so
 *      the snapshot is accurate at draft time — coordination across
 *      DemandLetter + Loan repos.
 *   3. Dispatch fires best-effort customer notifications across
 *      multiple channels (email + SMS) without rolling back the
 *      state transition if the notification fails.
 *
 * Discriminated unions surface every failure kind the HTTP layer needs
 * to map (403/404/409/400). The repo throws on invariant violations
 * (wrong status, missing data) — those come through as `RepoError`.
 */

const STAGE_LABEL: Record<string, string> = {
  FIRST: "First Demand Letter",
  FINAL: "Final Demand Letter",
  ATTORNEY_FIRST: "Attorney Demand Letter",
  ATTORNEY_FINAL: "Final Attorney Demand Letter",
};

type Letter = Awaited<ReturnType<DemandLetterRepository["findById"]>>;
type LetterRow = NonNullable<Letter>;
type BatchRow = Awaited<ReturnType<DemandLetterRepository["draftBatch"]>>;

export type BatchResult =
  | { ok: true; letters: BatchRow }
  | { ok: false; kind: "RepoError"; message: string };

export type ApproveResult =
  | { ok: true; letter: LetterRow }
  | { ok: false; kind: "NotFound" }
  | {
      ok: false;
      kind: "ForbiddenStagePerm" | "ForbiddenSelfApprove" | "RepoError";
      message: string;
    };

export type LetterResult =
  | { ok: true; letter: LetterRow }
  | { ok: false; kind: "RepoError"; message: string };

export class DemandLetterService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: DemandLetterRepository,
    private readonly loans: LoanRepository,
    private readonly notifications: NotificationRepository,
    private readonly audit: AuditLogRepository,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ─── reads ────────────────────────────────────────────────────────

  identifyCandidates(stage: DemandLetterStageEnum) {
    return this.repo.identifyCandidates(stage);
  }

  list(query: ListQuery) {
    return this.repo.list(query);
  }

  findById(id: string) {
    return this.repo.findById(id);
  }

  // ─── writes ───────────────────────────────────────────────────────

  async draftBatch(args: {
    input: BatchInput;
    actorId: string;
  }): Promise<BatchResult> {
    try {
      const created = await this.repo.draftBatch(
        {
          loanIds: args.input.loanIds,
          stage: args.input.stage,
          paymentDeadlineDays: args.input.paymentDeadlineDays,
          draftedById: args.actorId,
        },
        async (loanId) => {
          const t = await this.loans.accruedPenaltiesFor(loanId);
          return t.outstanding;
        },
      );
      await this.audit.record({
        action: "DEMAND_LETTER_BATCH_DRAFT",
        actorId: args.actorId,
        targetType: "DemandLetter",
        payload: {
          stage: args.input.stage,
          requested: args.input.loanIds.length,
          created: created.length,
        },
      });
      return { ok: true, letters: created };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async approve(args: {
    id: string;
    input: ApproveInput;
    actorId: string;
    callerPerms: Set<string>;
  }): Promise<ApproveResult> {
    const letter = await this.repo.findById(args.id);
    if (!letter) return { ok: false, kind: "NotFound" };

    // FRD §3.6.5: attorney stages require legal sign-off, earlier
    // stages need company sign-off.
    const requiredPerm =
      letter.stage === "ATTORNEY_FIRST" || letter.stage === "ATTORNEY_FINAL"
        ? "collections.dl_approve_legal"
        : "collections.dl_approve_company";
    if (!args.callerPerms.has(requiredPerm)) {
      return {
        ok: false,
        kind: "ForbiddenStagePerm",
        message: `Stage ${letter.stage} requires permission ${requiredPerm} (FRD §3.6.5).`,
      };
    }

    // Segregation of duties — drafter cannot self-approve.
    if (letter.draftedById === args.actorId) {
      return {
        ok: false,
        kind: "ForbiddenSelfApprove",
        message:
          "Drafter cannot self-approve (FRD §3.6.5 segregation of duties).",
      };
    }

    try {
      const updated = await this.repo.approve(args.id, {
        approvedById: args.actorId,
        note: args.input.note,
      });
      await this.audit.record({
        action: "DEMAND_LETTER_APPROVE",
        actorId: args.actorId,
        targetType: "DemandLetter",
        targetId: updated.id,
        payload: { stage: letter.stage, note: args.input.note },
      });
      return { ok: true, letter: updated };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async dispatch(args: {
    id: string;
    input: DispatchInput;
    actorId: string;
  }): Promise<LetterResult> {
    try {
      const letter = await this.repo.dispatch(args.id, {
        channel: args.input.channel,
        ref: args.input.ref,
        dispatchedById: args.actorId,
      });

      // Best-effort customer notification. The letter is *legally*
      // dispatched once the repo write lands; the SMS/email is
      // operational follow-up only, so a notification failure must
      // not roll back the state transition.
      await this.dispatchNotifications(letter.id).catch((err) =>
        this.log.warn({ err }, "Demand-letter notification dispatch failed"),
      );

      await this.audit.record({
        action: "DEMAND_LETTER_DISPATCH",
        actorId: args.actorId,
        targetType: "DemandLetter",
        targetId: letter.id,
        payload: {
          stage: letter.stage,
          channel: args.input.channel,
          ref: args.input.ref,
          loanId: letter.loanId,
        },
      });
      return { ok: true, letter };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async close(args: {
    id: string;
    input: CloseInput;
    actorId: string;
  }): Promise<LetterResult> {
    try {
      const letter = await this.repo.close(args.id, {
        status: args.input.status,
        reason: args.input.reason,
        closedById: args.actorId,
      });
      await this.audit.record({
        action:
          args.input.status === "WAIVED"
            ? "DEMAND_LETTER_WAIVE"
            : "DEMAND_LETTER_RESPONDED",
        actorId: args.actorId,
        targetType: "DemandLetter",
        targetId: letter.id,
        payload: { reason: args.input.reason },
      });
      return { ok: true, letter };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  // ─── internals ────────────────────────────────────────────────────

  /**
   * Fan-out per-channel customer notification for a freshly dispatched
   * letter. Pulls the customer contact info via Prisma directly (the
   * repo's shape doesn't include the customer join). Any single
   * channel's failure is allowed to bubble up — the caller wraps the
   * whole call in a catch so a partial dispatch is preferred over no
   * dispatch.
   */
  private async dispatchNotifications(letterId: string): Promise<void> {
    const full = await this.prisma.demandLetter.findUnique({
      where: { id: letterId },
      include: { loan: { include: { customer: true } } },
    });
    const c = full?.loan.customer;
    if (!full || !c || (!c.email && !c.phone)) return;

    const data = {
      customerName: `${c.firstName} ${c.lastName}`,
      loanNumber: full.loan.number,
      stageLabel: STAGE_LABEL[full.stage] ?? full.stage,
      totalOwed: Number(full.totalOwed).toFixed(2),
      paymentDeadline: full.paymentDeadline.toISOString().slice(0, 10),
    };
    const channels: Array<{ channel: "EMAIL" | "SMS"; recipient: string }> = [];
    if (c.email) channels.push({ channel: "EMAIL", recipient: c.email });
    if (c.phone) channels.push({ channel: "SMS", recipient: c.phone });

    for (const ch of channels) {
      await this.notifications.dispatch({
        event: "DEMAND_LETTER_DISPATCHED",
        channel: ch.channel,
        recipient: ch.recipient,
        data,
        refType: "DemandLetter",
        refId: full.id,
        customerId: c.id,
      });
    }
  }
}
