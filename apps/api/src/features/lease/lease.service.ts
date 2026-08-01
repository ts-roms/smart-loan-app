import { type AuditLogRepository, type LeaseRepository } from "@loan/db";

import type {
  BuyoutInput,
  CloseInput,
  ListQuery,
  PullOutInput,
} from "./schemas";

/**
 * Repo-agnostic alias for the LeaseAgreement row shape — we pin it via
 * `Awaited<ReturnType<...>>` so this file stays out of the
 * `@prisma/client` import path, matching how the other features keep
 * the API isolated from Prisma's surface area.
 */
type LeaseAgreementRow = Awaited<ReturnType<LeaseRepository["pullOut"]>>;

/**
 * Lease orchestration. Every state-transition method couples the repo
 * write to an audit-log record on success — that pairing is *why* we
 * have a service here. If you find yourself adding a new lease
 * transition, mirror the same pair.
 *
 * Failure shape: all transitions return a discriminated union. The
 * repo throws on invariant violations ("already bought out", "not
 * active") and the service catches those and returns
 * `{ ok: false, kind: "RepoError", message }`. The route layer maps
 * those to 400s.
 */

type AuditAction =
  "LEASE_BUYOUT" | "LEASE_PULL_OUT" | "LEASE_RETURNED" | "LEASE_EXTENDED";

export type BuyoutResult =
  | {
      ok: true;
      agreement: Awaited<
        ReturnType<LeaseRepository["completeBuyout"]>
      >["agreement"];
      journalEntryId: string;
    }
  | { ok: false; kind: "RepoError"; message: string };

export type TransitionResult =
  | { ok: true; agreement: LeaseAgreementRow }
  | { ok: false; kind: "RepoError"; message: string };

export class LeaseService {
  constructor(
    private readonly repo: LeaseRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  list(query: ListQuery) {
    return this.repo.list(query);
  }

  findForLoan(loanId: string) {
    return this.repo.findForLoan(loanId);
  }

  async completeBuyout(args: {
    loanId: string;
    input: BuyoutInput;
    actorId: string;
  }): Promise<BuyoutResult> {
    try {
      const result = await this.repo.completeBuyout({
        loanId: args.loanId,
        amountPaid: args.input.amountPaid,
        buyoutById: args.actorId,
      });
      await this.recordAudit({
        action: "LEASE_BUYOUT",
        actorId: args.actorId,
        agreementId: result.agreement.id,
        payload: {
          loanId: args.loanId,
          amountPaid: args.input.amountPaid,
          journalEntryId: result.journalEntryId,
        },
      });
      return {
        ok: true,
        agreement: result.agreement,
        journalEntryId: result.journalEntryId,
      };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async pullOut(args: {
    loanId: string;
    input: PullOutInput;
    actorId: string;
  }): Promise<TransitionResult> {
    try {
      const updated = await this.repo.pullOut({
        loanId: args.loanId,
        reason: args.input.reason,
        pulledOutById: args.actorId,
      });
      await this.recordAudit({
        action: "LEASE_PULL_OUT",
        actorId: args.actorId,
        agreementId: updated.id,
        payload: { loanId: args.loanId, reason: args.input.reason },
      });
      return { ok: true, agreement: updated };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async closeAsReturned(args: {
    loanId: string;
    input: CloseInput;
    actorId: string;
  }): Promise<TransitionResult> {
    return this.closeWith({
      ...args,
      method: (loanId, reason) => this.repo.closeAsReturned(loanId, reason),
      action: "LEASE_RETURNED",
    });
  }

  async closeAsExtended(args: {
    loanId: string;
    input: CloseInput;
    actorId: string;
  }): Promise<TransitionResult> {
    return this.closeWith({
      ...args,
      method: (loanId, reason) => this.repo.closeAsExtended(loanId, reason),
      action: "LEASE_EXTENDED",
    });
  }

  // ─── internals ────────────────────────────────────────────────────

  private async closeWith(args: {
    loanId: string;
    input: CloseInput;
    actorId: string;
    method: (loanId: string, reason: string) => Promise<LeaseAgreementRow>;
    action: AuditAction;
  }): Promise<TransitionResult> {
    try {
      const updated = await args.method(args.loanId, args.input.reason);
      await this.recordAudit({
        action: args.action,
        actorId: args.actorId,
        agreementId: updated.id,
        payload: { loanId: args.loanId, reason: args.input.reason },
      });
      return { ok: true, agreement: updated };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  private recordAudit(args: {
    action: AuditAction;
    actorId: string;
    agreementId: string;
    payload: Record<string, unknown>;
  }) {
    return this.audit.record({
      action: args.action,
      actorId: args.actorId,
      targetType: "LeaseAgreement",
      targetId: args.agreementId,
      payload: args.payload,
    });
  }
}
