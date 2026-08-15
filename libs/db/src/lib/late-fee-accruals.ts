/**
 * Batched lookup of late-fee accrual entries by schedule id.
 *
 * Late-fee postings are keyed `"<scheduleId>:<dayKey>"` in
 * `JournalEntry.sourceRefId` (see `lateFeeAccrualEntry`), so "what has already
 * accrued for this instalment" is a prefix query. Asking that question once
 * per instalment is finding F1 in docs/modernization/query-performance.md: the
 * nightly accrual ran it 8,472 times at measured volume.
 *
 * This asks it for many instalments at a time instead.
 *
 * WHAT THIS IS NOT
 *
 * It is not an idempotency guard and must never be used as one. The guarantee
 * that a late fee is posted once per instalment per day is the unique index on
 * (source, sourceRefType, sourceRefId), enforced through `postIfAbsent` —
 * which reads, attempts the insert anyway, and treats P2002 as "someone else
 * won". A batched pre-read is even less of a guard than a per-iteration one,
 * because it is read further ahead of the write it precedes. It exists only to
 * compute how much fee is already on the books so the job can post the delta.
 * The insert-and-catch behaviour in `postIfAbsent` stays exactly where it is.
 *
 * WHY CHUNKED
 *
 * The query is an `OR` of N `startsWith` clauses, which Postgres answers as a
 * BitmapOr over N prefix range scans on
 * `JournalEntry_source_refType_refId_prefix_idx`. That is efficient per branch
 * but the planner still has to build one bitmap per branch, and a single
 * 8,472-way OR is a large query to plan and a large statement to send. Chunking
 * keeps each statement to a sane size while still turning thousands of round
 * trips into a handful.
 */

import { addMoney } from "@loan/accounting";
import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Schedule ids per query. 500 keeps the statement small enough to plan quickly
 * while cutting the measured 8,472 round trips to 17.
 */
export const ACCRUAL_LOOKUP_CHUNK = 500;

/**
 * "<scheduleId>:<periodKey>" → the schedule id.
 *
 * `indexOf` + `slice` rather than `split(":")[0]` so the result is provably a
 * string under noUncheckedIndexedAccess.
 *
 * Grouping on the segment before the first colon is exactly equivalent to the
 * `startsWith "<id>:"` filter that selected the rows: schedule ids are uuids
 * and contain no colon, so "<a>:..." can only be produced by schedule <a>, and
 * a longer id sharing a prefix (there are none, but the argument should not
 * depend on that) still differs before its own colon.
 */
export function scheduleIdOfLateFeeRef(ref: string): string {
  const i = ref.indexOf(":");
  return i === -1 ? ref : ref.slice(0, i);
}

/** The shape both callers need: enough to find the Fee Income credit. */
export interface LateFeeAccrualEntry {
  sourceRefId: string | null;
  lines: Array<{
    credit: Prisma.Decimal;
    account: { code: string };
  }>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Every `LATE_FEE_ACCRUAL` entry for the given schedule ids, grouped by
 * schedule id. Schedule ids with no accruals are simply absent from the map;
 * callers treat a miss as "nothing accrued yet", which is what the per-
 * instalment query returned as an empty array.
 *
 * Issues no query at all for an empty input, matching the old code's
 * behaviour of never reaching the lookup when there was nothing to look up.
 */
export async function lateFeeAccrualsBySchedule(
  prisma: Tx,
  scheduleIds: readonly string[],
): Promise<Map<string, LateFeeAccrualEntry[]>> {
  const grouped = new Map<string, LateFeeAccrualEntry[]>();
  const unique = [...new Set(scheduleIds)];
  if (unique.length === 0) return grouped;

  for (const ids of chunk(unique, ACCRUAL_LOOKUP_CHUNK)) {
    const entries = await prisma.journalEntry.findMany({
      where: {
        source: "LATE_FEE_ACCRUAL",
        sourceRefType: "LoanScheduleLateFee",
        OR: ids.map((id) => ({ sourceRefId: { startsWith: `${id}:` } })),
      },
      include: { lines: { include: { account: true } } },
    });

    for (const entry of entries) {
      if (!entry.sourceRefId) continue;
      const scheduleId = scheduleIdOfLateFeeRef(entry.sourceRefId);
      const bucket = grouped.get(scheduleId);
      if (bucket) bucket.push(entry);
      else grouped.set(scheduleId, [entry]);
    }
  }

  return grouped;
}

/**
 * The Fee Income (4100) credit already on the books, for one instalment's
 * entries.
 *
 * Deliberately still a float `reduce`, and deliberately still `find` rather
 * than a sum over matching lines: this is the arithmetic the accrual and the
 * penalty read path both performed before F1, reproduced exactly so the
 * batching cannot move a number. Callers round the result.
 */
export function feeIncomeCreditOf(entries: LateFeeAccrualEntry[]): number {
  return entries.reduce((sum, e) => {
    const feeLine = e.lines.find((l) => l.account.code === "4100");
    return sum + (feeLine ? Number(feeLine.credit) : 0);
  }, 0);
}

/**
 * The same figure as `feeIncomeCreditOf`, as exact 2-decimal text.
 *
 * §11: this one feeds the payment allocator, so it must not be a float. The
 * `Decimal` off the line is handed to `addMoney` as its own decimal text and
 * summed in integer centavos; `Number(feeLine.credit)` never happens.
 *
 * Line SELECTION is identical to `feeIncomeCreditOf` on purpose — `find`,
 * not a sum over matching lines, and a missing 4100 line contributing zero
 * rather than being an error. An accrual entry has exactly one Fee Income
 * credit, so the two agree on every row this system writes; keeping the
 * selection identical means they also agree on any malformed historical row,
 * and a reconciliation check comparing a column against the ledger cannot
 * fail merely because two readers of the same entries disagreed about which
 * line to read.
 *
 * `feeIncomeCreditOf` stays where it is and stays a float: the nightly
 * accrual computes a delta against a policy figure that is itself a float,
 * and moving one half of that subtraction to exact arithmetic would change
 * postings by a centavo for no benefit. Callers that ALLOCATE use this one.
 */
export function accruedPenaltyOf(entries: LateFeeAccrualEntry[]): string {
  const credits: string[] = [];
  for (const e of entries) {
    const feeLine = e.lines.find((l) => l.account.code === "4100");
    if (feeLine) credits.push(feeLine.credit.toString());
  }
  return credits.length === 0 ? "0.00" : addMoney(...credits);
}
