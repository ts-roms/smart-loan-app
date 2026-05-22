import type { AccountingRepository, AuditLogRepository } from "@loan/db";
import { buildEntry } from "@loan/accounting";

import type {
  EntryInput,
  ReverseBulkInput,
  ReverseSingleInput,
} from "./schemas";

/**
 * Per-row outcome for the bulk-reverse endpoint. Returned via 207
 * Multi-Status so partial failure is observable. Stable shape between
 * repo + HTTP wire — the controller doesn't reshape it.
 */
export interface ReverseBulkRowResult {
  ok: boolean;
  entryId: string;
  reversalId?: string;
  reversalNumber?: string;
  error?: string;
}

export interface ReverseBulkOutcome {
  results: ReverseBulkRowResult[];
  succeeded: number;
  failed: number;
}

export interface PostEntryOutcome {
  ok: true;
  entry: Awaited<ReturnType<AccountingRepository["postEntry"]>>;
}

export interface PostEntryFailure {
  ok: false;
  kind: "BadRequest";
  message: string;
}

export type PostEntryResult = PostEntryOutcome | PostEntryFailure;

export interface ReverseEntryOutcome {
  ok: true;
  original: string;
  reversal: Awaited<
    ReturnType<AccountingRepository["reverseEntry"]>
  >["reversal"];
  alreadyReversed: boolean;
}

export interface ReverseEntryFailure {
  ok: false;
  kind: "BadRequest";
  message: string;
}

export type ReverseEntryResult = ReverseEntryOutcome | ReverseEntryFailure;

/**
 * Journal-posting service — the write paths on /accounting/journal.
 *
 * Earns its layer because every write here is audit-coupled: a manual
 * post writes a JournalEntry; a reverse writes a JournalEntry AND an
 * AuditEvent; a bulk reverse writes N JournalEntries AND an AuditEvent.
 * Keeping the audit calls next to the writes (rather than scattered
 * across route handlers) avoids the failure mode where a future
 * endpoint forgets to log.
 *
 * Read-only journal endpoints (list, get, ledger, reports) and the
 * COA endpoints stay inline in `accounting.routes.ts` — they're thin
 * repo passthroughs with no orchestration.
 */
export class JournalService {
  constructor(
    private readonly accounting: AccountingRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  /**
   * Post a manual journal entry. `buildEntry` enforces the balance
   * invariant (debits === credits, no negatives, no single-sided
   * lines); the repo persists it inside a transaction with the period
   * close-gate check.
   */
  async post(input: EntryInput, actorId: string): Promise<PostEntryResult> {
    try {
      const validated = buildEntry({
        entryDate: new Date(input.entryDate),
        memo: input.memo,
        source: "MANUAL",
        lines: input.lines,
      });
      const entry = await this.accounting.postEntry(validated, {
        postedById: actorId,
      });
      return { ok: true, entry };
    } catch (err) {
      return {
        ok: false,
        kind: "BadRequest",
        message: err instanceof Error ? err.message : "Invalid entry",
      };
    }
  }

  /**
   * Reverse a single journal entry. Writes the reversal row, then the
   * audit log unconditionally — including when `result.created === false`
   * (the entry was already reversed). Logging the no-op is intentional:
   * compliance reports that count `JOURNAL_REVERSE` rows rely on every
   * attempt being recorded, and "operator X kept hitting reverse on a
   * closed entry" is exactly the trail an investigator needs. The
   * `created` field in the payload distinguishes the first reversal
   * from the no-op follow-ups.
   */
  async reverse(
    entryId: string,
    input: ReverseSingleInput,
    actorId: string,
  ): Promise<ReverseEntryResult> {
    try {
      const result = await this.accounting.reverseEntry(entryId, {
        postedById: actorId,
        memo: input.memo,
      });
      await this.audit.record({
        action: "JOURNAL_REVERSE",
        actorId,
        targetType: "JournalEntry",
        targetId: entryId,
        payload: {
          reversalId: result.reversal.id,
          reversalNumber: result.reversal.number,
          created: result.created,
          memo: input.memo,
        },
      });
      return {
        ok: true,
        original: result.original.id,
        reversal: result.reversal,
        alreadyReversed: !result.created,
      };
    } catch (err) {
      return {
        ok: false,
        kind: "BadRequest",
        message: (err as Error).message,
      };
    }
  }

  /**
   * Reverse a batch of entries. Per-row failures are reported
   * individually; the audit log records the batch summary so a
   * compliance review can see "operator X tried to reverse Y, Z
   * succeeded, the rest failed because P".
   */
  async reverseBulk(
    input: ReverseBulkInput,
    actorId: string,
  ): Promise<ReverseBulkOutcome> {
    const results = await this.accounting.reverseEntriesBulk(input.entryIds, {
      postedById: actorId,
      memoTemplate: input.memo,
    });
    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    await this.audit.record({
      action: "JOURNAL_REVERSE_BULK",
      actorId,
      payload: {
        requested: input.entryIds.length,
        succeeded,
        failed,
        memo: input.memo,
        results,
      },
    });
    return { results, succeeded, failed };
  }
}
