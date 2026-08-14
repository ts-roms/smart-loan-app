import type {
  AccountingRepository,
  AuditLogRepository,
  PrismaClient,
} from "@loan/db";
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
    /**
     * Needed only so `post()` can put the entry and its §56 audit row in
     * one transaction. Optional so the existing two-argument
     * construction in tests keeps working; when absent, `post()` falls
     * back to writing the audit row immediately after the entry.
     */
    private readonly prisma?: PrismaClient,
  ) {}

  /**
   * Post a manual journal entry. `buildEntry` enforces the balance
   * invariant (debits === credits, no negatives, no single-sided
   * lines); the repo persists it inside a transaction with the period
   * close-gate check.
   *
   * §56: a manual journal entry is an operator moving money on the
   * ledger by hand, with no loan or payment behind it to explain it —
   * the single most reviewable action in the accounting module, and
   * until now the only write here that left no audit row (reverse and
   * reverseBulk already did). It is audited inside the same transaction
   * as the entry, so an entry cannot exist without its record.
   */
  async post(input: EntryInput, actorId: string): Promise<PostEntryResult> {
    try {
      const validated = buildEntry({
        entryDate: new Date(input.entryDate),
        memo: input.memo,
        source: "MANUAL",
        lines: input.lines,
      });
      const write = async (tx?: PrismaClient) => {
        const entry = await this.accounting.postEntry(validated, {
          postedById: actorId,
          tx,
        });
        await this.audit.recordRequired({
          action: "JOURNAL_POST",
          actorId,
          targetType: "JournalEntry",
          targetId: entry.id,
          tx,
          reason: input.memo ?? null,
          newValue: {
            entryDate: entry.entryDate,
            memo: entry.memo,
            source: "MANUAL",
            // The lines are the entry. Without them the audit row says
            // "someone posted something", which is not an audit trail.
            lines: validated.lines.map((l) => ({
              accountCode: l.accountCode,
              debit: l.debit,
              credit: l.credit,
            })),
          },
        });
        return entry;
      };
      const entry = this.prisma
        ? await this.prisma.$transaction((tx) => write(tx as PrismaClient))
        : await write();
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
