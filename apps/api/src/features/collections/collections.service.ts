import { type CollectionsRepository, type PrismaClient } from "@loan/db";

import type {
  AssignInput,
  NoteInput,
  PtpInput,
  QueueScope,
  ResolveInput,
} from "./schemas";

/**
 * Collections orchestration. Notes + PTPs + queue + the late-fee
 * accrual job. The repo does the heavy work (overdue calc, PTP state
 * transitions, fee accrual posting); this service is a thin wrapper
 * that converts the late-fee accrual's throw into a discriminated
 * result so the controller can render a 409 cleanly.
 */

export type AccrueResult =
  | {
      ok: true;
      result: Awaited<ReturnType<CollectionsRepository["accrueLateFees"]>>;
    }
  | { ok: false; kind: "AccrualFailed"; message: string };

export class CollectionsService {
  constructor(
    private readonly repo: CollectionsRepository,
    /**
     * Tenant-scoped user table. Assignment has to answer "is this a real,
     * active user who may hold accounts", which is a User question the
     * collections repo has no business owning.
     */
    private readonly users: PrismaClient["user"],
  ) {}

  /**
   * The overdue queue, scoped.
   *
   * `actorId` is the authenticated caller, not a parameter the client
   * chooses — "mine" means the person asking. See queueScopeSchema.
   */
  overdueQueue(args: { scope: QueueScope["scope"]; actorId: string }) {
    if (args.scope === "mine") {
      return this.repo.overdueQueue(new Date(), {
        collectorId: args.actorId,
      });
    }
    if (args.scope === "unassigned") {
      return this.repo.overdueQueue(new Date(), { unassignedOnly: true });
    }
    return this.repo.overdueQueue();
  }

  // ─── account ownership ────────────────────────────────────────────

  /**
   * Assign or reassign an account.
   *
   * Rejects an unknown or deactivated collector up front. Without the
   * check the FK would still hold, but a deactivated user can be
   * assigned work they can never sign in to do — the account then looks
   * covered and is silently orphaned.
   */
  async assign(args: {
    loanId: string;
    input: AssignInput;
    actorId: string;
  }): Promise<
    | { ok: true; value: Awaited<ReturnType<CollectionsRepository["assign"]>> }
    | { ok: false; kind: "UnknownCollector" | "InactiveCollector" }
  > {
    const collector = await this.users.findUnique({
      where: { id: args.input.collectorId },
      select: { id: true, active: true },
    });
    if (!collector) return { ok: false, kind: "UnknownCollector" };
    if (!collector.active) return { ok: false, kind: "InactiveCollector" };

    return {
      ok: true,
      value: await this.repo.assign({
        loanId: args.loanId,
        collectorId: args.input.collectorId,
        assignedById: args.actorId,
        note: args.input.note,
      }),
    };
  }

  unassign(loanId: string) {
    return this.repo.unassign(loanId);
  }

  workload() {
    return this.repo.workloadByCollector();
  }

  /**
   * Users who can hold accounts — for the assign picker. COLLECTOR and
   * LOAN_OFFICER, since officers work their own delinquencies too, and
   * only active ones.
   */
  assignableCollectors() {
    return this.users.findMany({
      where: { active: true, role: { in: ["COLLECTOR", "LOAN_OFFICER"] } },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" },
    });
  }

  // ─── notes ────────────────────────────────────────────────────────

  listNotes(loanId: string) {
    return this.repo.listNotes(loanId);
  }

  addNote(args: { loanId: string; input: NoteInput; actorId: string }) {
    return this.repo.addNote(args.loanId, {
      type: args.input.type,
      body: args.input.body,
      createdById: args.actorId,
    });
  }

  // ─── promises to pay ──────────────────────────────────────────────

  listPromises(loanId: string) {
    return this.repo.listPromises(loanId);
  }

  createPromise(args: { loanId: string; input: PtpInput; actorId: string }) {
    return this.repo.createPromise(args.loanId, {
      amount: args.input.amount,
      promisedDate: new Date(args.input.promisedDate),
      note: args.input.note,
      createdById: args.actorId,
    });
  }

  resolvePromise(id: string, input: ResolveInput) {
    return this.repo.resolvePromise(id, input.status);
  }

  // ─── late-fee accrual job ─────────────────────────────────────────

  async accrueLateFees(actorId: string): Promise<AccrueResult> {
    try {
      const result = await this.repo.accrueLateFees(new Date(), actorId);
      return { ok: true, result };
    } catch (err) {
      // The repo throws when a period is closed or the chart-of-
      // accounts is misconfigured — both of which are 409 territory
      // (the request was well-formed; the world isn't in a state where
      // we can satisfy it).
      return {
        ok: false,
        kind: "AccrualFailed",
        message: (err as Error).message,
      };
    }
  }
}
