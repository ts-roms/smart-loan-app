import { type CollectionsRepository } from "@loan/db";

import type { NoteInput, PtpInput, ResolveInput } from "./schemas.js";

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
  constructor(private readonly repo: CollectionsRepository) {}

  overdueQueue() {
    return this.repo.overdueQueue();
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
