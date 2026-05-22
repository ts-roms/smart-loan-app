import {
  type AuditLogRepository,
  type LoanRepository,
  type PrismaClient,
  type RepossessionRepository,
} from "@loan/db";

import type {
  ApprovalInput,
  AssignInput,
  AuctionInput,
  CancelInput,
  ListQuery,
  OpenInput,
  RecoverInput,
} from "./schemas.js";

/**
 * Repossession orchestration. Eight state-transition methods, each
 * paired with an audit-log record on success. The repo enforces the
 * state-machine invariants and throws when a transition is invalid;
 * the service catches those and surfaces them as
 * `{ ok: false, kind: "RepoError", ... }` for the controller to map.
 *
 * The auction transition is the heaviest — it posts the
 * settlement journal entry as part of the same repo call, so the
 * audit payload echoes the journal id back out for traceability.
 *
 * `outstanding` is here because the figure mixes data from two repos
 * (schedule rows + accrued penalties) — that bit of math doesn't
 * belong inline in the route handler.
 */

type RepoCase = Awaited<ReturnType<RepossessionRepository["openCase"]>>;
type AuctionResult = Awaited<ReturnType<RepossessionRepository["auction"]>>;

type AuditAction =
  | "REPOSSESSION_IDENTIFY"
  | "REPOSSESSION_BM_APPROVE"
  | "REPOSSESSION_CREDIT_APPROVE"
  | "REPOSSESSION_LEGAL_APPROVE"
  | "REPOSSESSION_ASSIGN_AGENT"
  | "REPOSSESSION_RECOVER"
  | "REPOSSESSION_AUCTION"
  | "REPOSSESSION_CANCEL";

export type CaseResult =
  | { ok: true; case: RepoCase }
  | { ok: false; kind: "RepoError"; message: string };

export type AuctionOutcome =
  | { ok: true; result: AuctionResult }
  | { ok: false; kind: "RepoError"; message: string };

export class RepossessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: RepossessionRepository,
    private readonly loans: LoanRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  // ─── reads ────────────────────────────────────────────────────────

  list(query: ListQuery) {
    return this.repo.list({
      status: query.status as never,
      loanId: query.loanId,
    });
  }

  findById(id: string) {
    return this.repo.findById(id);
  }

  /**
   * Combined outstanding figure for the recover form to default-fill.
   * Pulls unpaid schedule rows + accrued penalties for the case's loan.
   */
  async outstanding(caseId: string): Promise<
    | { ok: false; kind: "NotFound" }
    | {
        ok: true;
        outstandingPrincipal: number;
        outstandingPenalties: number;
        totalOutstanding: number;
      }
  > {
    const c = await this.repo.findById(caseId);
    if (!c) return { ok: false, kind: "NotFound" };
    const schedule = await this.prisma.loanSchedule.findMany({
      where: { loanId: c.loanId, paidInFullAt: null },
    });
    const outstanding = schedule.reduce(
      (s, x) => s + (Number(x.totalDue) - Number(x.principalPaid)),
      0,
    );
    const penalties = await this.loans.accruedPenaltiesFor(c.loanId);
    return {
      ok: true,
      outstandingPrincipal: Math.round(outstanding * 100) / 100,
      outstandingPenalties: penalties.outstanding,
      totalOutstanding:
        Math.round((outstanding + penalties.outstanding) * 100) / 100,
    };
  }

  // ─── transitions ──────────────────────────────────────────────────

  async openCase(args: {
    input: OpenInput;
    actorId: string;
  }): Promise<CaseResult> {
    return this.withAudit({
      action: "REPOSSESSION_IDENTIFY",
      actorId: args.actorId,
      payload: { loanId: args.input.loanId, reason: args.input.reason },
      run: () =>
        this.repo.openCase({
          loanId: args.input.loanId,
          reason: args.input.reason,
          identifiedById: args.actorId,
        }),
    });
  }

  bmApprove(args: { caseId: string; input: ApprovalInput; actorId: string }) {
    return this.approve(args, "REPOSSESSION_BM_APPROVE", "bmApprove");
  }

  creditApprove(args: {
    caseId: string;
    input: ApprovalInput;
    actorId: string;
  }) {
    return this.approve(
      args,
      "REPOSSESSION_CREDIT_APPROVE",
      "creditHeadApprove",
    );
  }

  legalApprove(args: {
    caseId: string;
    input: ApprovalInput;
    actorId: string;
  }) {
    return this.approve(args, "REPOSSESSION_LEGAL_APPROVE", "legalApprove");
  }

  async assignAgent(args: {
    caseId: string;
    input: AssignInput;
    actorId: string;
  }): Promise<CaseResult> {
    return this.withAudit({
      action: "REPOSSESSION_ASSIGN_AGENT",
      actorId: args.actorId,
      targetId: args.caseId,
      payload: args.input,
      run: () =>
        this.repo.assignAgent({
          caseId: args.caseId,
          agentName: args.input.agentName,
          agentContact: args.input.agentContact,
          assignedById: args.actorId,
        }),
    });
  }

  async recover(args: {
    caseId: string;
    input: RecoverInput;
    actorId: string;
  }): Promise<CaseResult> {
    return this.withAudit({
      action: "REPOSSESSION_RECOVER",
      actorId: args.actorId,
      targetId: args.caseId,
      payload: {
        outstanding: args.input.outstandingAtRecovery,
        storage: args.input.storageLocation,
      },
      run: () =>
        this.repo.recover({
          caseId: args.caseId,
          vehicleCondition: args.input.vehicleCondition,
          vehicleMileage: args.input.vehicleMileage,
          vehiclePhotos: args.input.vehiclePhotos,
          storageLocation: args.input.storageLocation,
          outstandingAtRecovery: args.input.outstandingAtRecovery,
          recoveredById: args.actorId,
        }),
    });
  }

  async auction(args: {
    caseId: string;
    input: AuctionInput;
    actorId: string;
  }): Promise<AuctionOutcome> {
    try {
      const result = await this.repo.auction({
        caseId: args.caseId,
        auctionMethod: args.input.auctionMethod,
        auctionProceeds: args.input.auctionProceeds,
        auctionedById: args.actorId,
      });
      await this.audit.record({
        action: "REPOSSESSION_AUCTION",
        actorId: args.actorId,
        targetType: "RepossessionCase",
        targetId: args.caseId,
        payload: {
          method: args.input.auctionMethod,
          proceeds: args.input.auctionProceeds,
          deficiency: result.deficiency,
          surplus: result.surplus,
          journalEntryId: result.journalEntryId,
        },
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async cancel(args: {
    caseId: string;
    input: CancelInput;
    actorId: string;
  }): Promise<CaseResult> {
    return this.withAudit({
      action: "REPOSSESSION_CANCEL",
      actorId: args.actorId,
      targetId: args.caseId,
      payload: { reason: args.input.reason },
      run: () =>
        this.repo.cancel({
          caseId: args.caseId,
          reason: args.input.reason,
          cancelledById: args.actorId,
        }),
    });
  }

  // ─── internals ────────────────────────────────────────────────────

  private async approve(
    args: { caseId: string; input: ApprovalInput; actorId: string },
    action: AuditAction,
    method: "bmApprove" | "creditHeadApprove" | "legalApprove",
  ): Promise<CaseResult> {
    return this.withAudit({
      action,
      actorId: args.actorId,
      targetId: args.caseId,
      payload: { note: args.input.note },
      run: () =>
        this.repo[method]({
          caseId: args.caseId,
          approvedById: args.actorId,
          note: args.input.note,
        }),
    });
  }

  private async withAudit(args: {
    action: AuditAction;
    actorId: string;
    targetId?: string;
    payload: Record<string, unknown>;
    run: () => Promise<RepoCase>;
  }): Promise<CaseResult> {
    try {
      const result = await args.run();
      await this.audit.record({
        action: args.action,
        actorId: args.actorId,
        targetType: "RepossessionCase",
        targetId: args.targetId ?? result.id,
        payload: args.payload,
      });
      return { ok: true, case: result };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }
}
