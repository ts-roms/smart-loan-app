import {
  idOrNumberWhere,
  type CollectionsRepository,
  type PrismaClient,
} from "@loan/db";

import type {
  AssignInput,
  BulkAssignInput,
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
    /**
     * Tenant-scoped loans. Assignment names a loan in its URL and that
     * identifier may be a loan number, so it has to be resolved before
     * the assignment row can key on it.
     */
    private readonly loans: PrismaClient["loanApplication"],
  ) {}

  /**
   * The overdue queue, scoped.
   *
   * `actorId` is the authenticated caller, not a parameter the client
   * chooses — "mine" means the person asking. See queueScopeSchema.
   */
  overdueQueue(args: {
    scope: QueueScope["scope"];
    actorId: string;
    province?: string;
    city?: string;
    page?: number;
    pageSize?: number;
  }) {
    const area = { province: args.province, city: args.city };
    const paging = { page: args.page, pageSize: args.pageSize };
    if (args.scope === "mine") {
      return this.repo.overdueQueuePage(
        new Date(),
        { ...area, collectorId: args.actorId },
        paging,
      );
    }
    if (args.scope === "unassigned") {
      return this.repo.overdueQueuePage(
        new Date(),
        { ...area, unassignedOnly: true },
        paging,
      );
    }
    return this.repo.overdueQueuePage(new Date(), area, paging);
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
    loanIdOrNumber: string;
    input: AssignInput;
    actorId: string;
  }): Promise<
    | { ok: true; value: Awaited<ReturnType<CollectionsRepository["assign"]>> }
    | {
        ok: false;
        kind: "UnknownLoan" | "UnknownCollector" | "InactiveCollector";
      }
  > {
    /*
     * Resolve the loan first. It also accepts a number, and without this
     * the assignment row would be written with whatever string arrived —
     * a number then fails the foreign key and surfaces as a raw 500 with
     * the Prisma error and a file path in the body.
     */
    const loan = await this.loans.findFirst({
      where: idOrNumberWhere(args.loanIdOrNumber),
      select: { id: true },
    });
    if (!loan) return { ok: false, kind: "UnknownLoan" };

    /*
     * `collector` is a UUID or an email — the schema accepts either, so
     * pick the column by shape. Email is matched case-insensitively:
     * addresses are stored as typed at signup, and someone reassigning
     * from a script or a spreadsheet will not reproduce the casing.
     */
    const collector = await this.users.findFirst({
      where: args.input.collector.includes("@")
        ? { email: { equals: args.input.collector, mode: "insensitive" } }
        : { id: args.input.collector },
      select: { id: true, active: true },
    });
    if (!collector) return { ok: false, kind: "UnknownCollector" };
    if (!collector.active) return { ok: false, kind: "InactiveCollector" };

    return {
      ok: true,
      value: await this.repo.assign({
        loanId: loan.id,
        // The resolved id, never the caller's string — it may be an email.
        collectorId: collector.id,
        assignedById: args.actorId,
        note: args.input.note,
      }),
    };
  }

  /**
   * Bulk assignment — same collector resolution and validation as
   * `assign`, run once for the whole batch instead of per account. Loan
   * ids come straight off the queue UI as UUIDs, so there's no
   * id-or-number resolution here; ids that no longer exist are reported
   * back in `missing` rather than failing the batch.
   */
  async assignBulk(args: {
    input: BulkAssignInput;
    actorId: string;
  }): Promise<
    | { ok: true; value: { assigned: number; missing: string[] } }
    | { ok: false; kind: "UnknownCollector" | "InactiveCollector" }
  > {
    const collector = await this.users.findFirst({
      where: args.input.collector.includes("@")
        ? { email: { equals: args.input.collector, mode: "insensitive" } }
        : { id: args.input.collector },
      select: { id: true, active: true },
    });
    if (!collector) return { ok: false, kind: "UnknownCollector" };
    if (!collector.active) return { ok: false, kind: "InactiveCollector" };

    return {
      ok: true,
      value: await this.repo.assignBulk({
        loanIds: args.input.loanIds,
        collectorId: collector.id,
        assignedById: args.actorId,
        note: args.input.note,
      }),
    };
  }

  /** Returns false when the loan doesn't exist OR had no assignment —
   *  both mean "there is nothing assigned", which is what DELETE asks
   *  for, so the route reports 204 either way. */
  async unassign(loanIdOrNumber: string) {
    const loan = await this.loans.findFirst({
      where: idOrNumberWhere(loanIdOrNumber),
      select: { id: true },
    });
    if (!loan) return false;
    return this.repo.unassign(loan.id);
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
