import type { PrismaClient } from "@prisma/client";

/**
 * Standing reconciliation — the ledger checking itself.
 *
 * Phase 2.3 of docs/modernization/roadmap.md, and the answer to the
 * pattern that produced every P0 this modernization has closed. Journal
 * duplication, double disbursement, duplicate payments, a recovery
 * booked as a liability — all four wrote entries that BALANCED. The
 * trial balance tied, the period closed, and nothing complained,
 * because a balanced entry is not the same as a correct one.
 *
 * The identity the brief (§10) asks for:
 *
 *   Loan Balance = Loan Transactions = Payment Allocations = Accounting Entries
 *
 * These checks assert what can be asserted without ambiguity. A
 * reconciliation job that cries wolf is a job that gets muted, so
 * anything that cannot be stated exactly is reported as a figure rather
 * than a failure.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A centavo. Rounding across thousands of rows lands here legitimately. */
const TOLERANCE = 0.01;

export interface ReconciliationCheck {
  name: string;
  /** One line, safe to put in an alert. */
  summary: string;
  ok: boolean;
  /** Signed difference where the check is a comparison. */
  delta?: number;
  /** Offending rows, capped — an alert wants a sample, not a dump. */
  offenders?: string[];
}

export interface ReconciliationResult {
  ranAt: string;
  ok: boolean;
  checks: ReconciliationCheck[];
}

const SAMPLE = 10;

/**
 * Run every check. Never throws for a *finding* — a failed check is a
 * result, not an exception. It throws only if the database itself is
 * unreachable, which is a different problem with a different response.
 */
export async function runReconciliation(
  prisma: PrismaClient,
): Promise<ReconciliationResult> {
  const checks: ReconciliationCheck[] = [];

  checks.push(await trialBalanceTies(prisma));
  checks.push(await everyEntryBalances(prisma));
  checks.push(await noDuplicateSourceRefs(prisma));
  checks.push(await scheduleProgressWithinBounds(prisma));
  checks.push(await penaltyProgressMatchesLedger(prisma));
  checks.push(await receivableMatchesSubledger(prisma));

  return {
    ranAt: new Date().toISOString(),
    ok: checks.every((c) => c.ok),
    checks,
  };
}

/** Total debits across the whole ledger must equal total credits. */
async function trialBalanceTies(
  prisma: PrismaClient,
): Promise<ReconciliationCheck> {
  const agg = await prisma.journalLine.aggregate({
    _sum: { debit: true, credit: true },
  });
  const debit = r2(Number(agg._sum.debit ?? 0));
  const credit = r2(Number(agg._sum.credit ?? 0));
  const delta = r2(debit - credit);
  return {
    name: "trial_balance",
    ok: Math.abs(delta) <= TOLERANCE,
    delta,
    summary:
      Math.abs(delta) <= TOLERANCE
        ? `Trial balance ties at ${debit.toFixed(2)}.`
        : `TRIAL BALANCE OUT BY ${delta.toFixed(2)} (debits ${debit.toFixed(2)}, credits ${credit.toFixed(2)}).`,
  };
}

/**
 * And each entry individually. The global check above can tie while two
 * entries are wrong in opposite directions — unlikely by accident,
 * which is precisely why it is worth checking separately.
 */
async function everyEntryBalances(
  prisma: PrismaClient,
): Promise<ReconciliationCheck> {
  const rows = await prisma.$queryRaw<
    { number: string; debit: number; credit: number }[]
  >`
    SELECT e."number",
           COALESCE(SUM(l."debit"), 0)::float8  AS debit,
           COALESCE(SUM(l."credit"), 0)::float8 AS credit
    FROM "JournalEntry" e
    LEFT JOIN "JournalLine" l ON l."entryId" = e."id"
    GROUP BY e."id", e."number"
    HAVING ABS(COALESCE(SUM(l."debit"), 0) - COALESCE(SUM(l."credit"), 0)) > 0.01
    ORDER BY e."number"
  `;
  return {
    name: "entry_balance",
    ok: rows.length === 0,
    offenders: rows
      .slice(0, SAMPLE)
      .map((r) => `${r.number} (Dr ${r2(r.debit)} / Cr ${r2(r.credit)})`),
    summary:
      rows.length === 0
        ? "Every journal entry balances."
        : `${rows.length} journal entr${rows.length === 1 ? "y does" : "ies do"} not balance.`,
  };
}

/**
 * Auto-posted entries are idempotent on (source, sourceRefType,
 * sourceRefId) and a unique index enforces it. This check exists for
 * data written BEFORE that index — it cannot fail on rows created
 * since, which is the point: it proves the historical set is clean too.
 */
async function noDuplicateSourceRefs(
  prisma: PrismaClient,
): Promise<ReconciliationCheck> {
  const rows = await prisma.$queryRaw<
    {
      source: string;
      ref_type: string | null;
      ref_id: string;
      copies: number;
    }[]
  >`
    SELECT "source"::text AS source, "sourceRefType" AS ref_type,
           "sourceRefId" AS ref_id, COUNT(*)::int AS copies
    FROM "JournalEntry"
    WHERE "sourceRefId" IS NOT NULL
    GROUP BY "source", "sourceRefType", "sourceRefId"
    HAVING COUNT(*) > 1
  `;
  return {
    name: "duplicate_source_refs",
    ok: rows.length === 0,
    offenders: rows
      .slice(0, SAMPLE)
      .map((r) => `${r.source}/${r.ref_type ?? "-"}/${r.ref_id} ×${r.copies}`),
    summary:
      rows.length === 0
        ? "No duplicate auto-posted entries."
        : `${rows.length} source reference(s) posted more than once.`,
  };
}

/**
 * A borrower cannot have paid more toward an instalment than it asks
 * for, and no column may be negative. Both are cheap to check and both
 * indicate an allocation that has gone wrong upstream.
 */
async function scheduleProgressWithinBounds(
  prisma: PrismaClient,
): Promise<ReconciliationCheck> {
  const rows = await prisma.$queryRaw<
    { number: string; installment: number; reason: string }[]
  >`
    SELECT l."number", s."installmentNo" AS installment,
           CASE
             WHEN s."principalPaid" < 0 OR s."interestPaid" < 0 THEN 'negative paid'
             WHEN s."principalPaid" > s."principalDue" + 0.01 THEN 'principal overpaid'
             ELSE 'interest overpaid'
           END AS reason
    FROM "LoanSchedule" s
    JOIN "LoanApplication" l ON l."id" = s."loanId"
    WHERE s."principalPaid" < 0
       OR s."interestPaid" < 0
       OR s."principalPaid" > s."principalDue" + 0.01
       OR s."interestPaid"  > s."interestDue"  + 0.01
    ORDER BY l."number", s."installmentNo"
  `;
  return {
    name: "schedule_bounds",
    ok: rows.length === 0,
    offenders: rows
      .slice(0, SAMPLE)
      .map((r) => `${r.number} #${r.installment}: ${r.reason}`),
    summary:
      rows.length === 0
        ? "Every instalment's progress is within its due amounts."
        : `${rows.length} instalment(s) have impossible progress.`,
  };
}

/**
 * The per-instalment penalty figures against the two things that produced
 * them.
 *
 * `LoanSchedule.penaltyPaid` and `penaltyWaived` are the only part of the
 * penalty story that is not derivable — the ledger records what accrued and
 * what was forgiven in total, but nothing in it says which instalment a
 * collection settled or which one a loan-level waiver relieved. That makes
 * them the only place a per-instalment figure can drift away from the
 * loan-level truth, so they are checked directly rather than hoped about.
 *
 * Two ways they can diverge, and both are caught here:
 *
 *   ATTRIBUTION. Every peso of every `PenaltyWaiver` is attributed to some
 *   instalment when the waiver is granted, oldest-first. If those shares
 *   stop adding up to the waiver row — a partial write, a repair script, a
 *   waiver granted while the attribution loop was wrong — the loan-level
 *   report and the per-instalment balances disagree about what a borrower
 *   owes, and the borrower will meet whichever one the payment path reads.
 *
 *   OVER-RELIEF. An instalment cannot have been relieved of more penalty
 *   than accrued against it. `paid + waived > accrued` means either the same
 *   peso was both collected and written off, or a payment allocated against
 *   a balance that was not there.
 *
 * The accrued side is reconstructed from the ledger exactly as the
 * application reads it — `LATE_FEE_ACCRUAL` / `LoanScheduleLateFee` entries
 * whose `sourceRefId` is `"<scheduleId>:<periodKey>"`, taking the Fee Income
 * (4100) credit. `split_part(…, ':', 1)` is the same join the application's
 * `startsWith '<id>:'` filter performs, read the other way: schedule ids are
 * uuids and carry no colon.
 */
async function penaltyProgressMatchesLedger(
  prisma: PrismaClient,
): Promise<ReconciliationCheck> {
  const rows = await prisma.$queryRaw<
    { number: string; installment: number | null; reason: string }[]
  >`
    WITH accrual AS (
      SELECT split_part(e."sourceRefId", ':', 1) AS schedule_id,
             SUM(l."credit")                     AS accrued
        FROM "JournalEntry" e
        JOIN "JournalLine"  l ON l."entryId" = e."id"
        JOIN "Account"      a ON a."id"      = l."accountId"
       WHERE e."source"        = 'LATE_FEE_ACCRUAL'
         AND e."sourceRefType" = 'LoanScheduleLateFee'
         AND e."sourceRefId"  IS NOT NULL
         AND a."code"          = '4100'
       GROUP BY 1
    ),
    over_relieved AS (
      SELECT l."number", s."installmentNo" AS installment,
             CASE
               WHEN s."penaltyPaid" < 0 OR s."penaltyWaived" < 0
                 THEN 'negative penalty progress'
               ELSE 'penalty relieved beyond what accrued'
             END AS reason
        FROM "LoanSchedule" s
        JOIN "LoanApplication" l ON l."id" = s."loanId"
        LEFT JOIN accrual ac ON ac."schedule_id" = s."id"
       WHERE s."penaltyPaid" < 0
          OR s."penaltyWaived" < 0
          OR s."penaltyPaid" + s."penaltyWaived"
             > COALESCE(ac."accrued", 0) + 0.01
    ),
    unattributed AS (
      SELECT l."number", NULL::int AS installment,
             'waivers do not match attributed shares' AS reason
        FROM "LoanApplication" l
        JOIN (
          SELECT "loanId", SUM("waivedAmount") AS total
            FROM "PenaltyWaiver" GROUP BY "loanId"
        ) w ON w."loanId" = l."id"
        LEFT JOIN (
          SELECT "loanId", SUM("penaltyWaived") AS total
            FROM "LoanSchedule" GROUP BY "loanId"
        ) s ON s."loanId" = l."id"
       WHERE ABS(w."total" - COALESCE(s."total", 0)) > 0.01
    )
    SELECT * FROM over_relieved
    UNION ALL
    SELECT * FROM unattributed
    ORDER BY "number", installment
  `;
  return {
    name: "penalty_subledger",
    ok: rows.length === 0,
    offenders: rows
      .slice(0, SAMPLE)
      .map((r) =>
        r.installment === null
          ? `${r.number}: ${r.reason}`
          : `${r.number} #${r.installment}: ${r.reason}`,
      ),
    summary:
      rows.length === 0
        ? "Every instalment's penalty progress is backed by the ledger."
        : `${rows.length} penalty balance(s) disagree with the ledger.`,
  };
}

/**
 * The one that matters: does the general ledger agree with the loan
 * book?
 *
 * GL Loans Receivable should equal the outstanding principal across
 * every schedule, PLUS late fees accrued to the receivable and not yet
 * waived, MINUS late fees the borrower has since paid. Late-fee accrual
 * debits Loans Receivable without touching principalDue, so leaving it
 * out would report a false difference on any book with an overdue
 * account — the exact false positive that would get this job muted.
 *
 * The `penaltyPaid` term is the one this identity gained when penalties
 * became collectable, and without it this check would have started
 * failing on the first late fee anyone paid. Collecting a penalty is
 * Dr Cash / Cr Loans Receivable: it reduces the GL side while leaving
 * `principalDue - principalPaid` and the accrual totals exactly where
 * they were, so the difference is the collection itself.
 *
 * That makes this check the tie between `LoanSchedule.penaltyPaid` and
 * the general ledger. The column is the only record of which instalment
 * a collection settled — the credit itself is indistinguishable from a
 * principal credit but for its memo — so if the column and the posting
 * ever disagree, the gap shows up here as a signed delta.
 *
 * A settled loan contributes nothing from either side: write-off,
 * restructure and closure all mark their instalments paid AND credit
 * the receivable, so the two move together.
 */
async function receivableMatchesSubledger(
  prisma: PrismaClient,
): Promise<ReconciliationCheck> {
  const [glAgg, sched, feeAgg, waiveAgg] = await Promise.all([
    prisma.journalLine.aggregate({
      where: { account: { code: "1100" } },
      _sum: { debit: true, credit: true },
    }),
    prisma.loanSchedule.aggregate({
      _sum: { principalDue: true, principalPaid: true, penaltyPaid: true },
    }),
    prisma.journalLine.aggregate({
      where: {
        account: { code: "1100" },
        entry: { source: "LATE_FEE_ACCRUAL" },
      },
      _sum: { debit: true, credit: true },
    }),
    prisma.journalLine.aggregate({
      where: { account: { code: "1100" }, entry: { source: "PENALTY_WAIVE" } },
      _sum: { debit: true, credit: true },
    }),
  ]);

  const gl = r2(Number(glAgg._sum.debit ?? 0) - Number(glAgg._sum.credit ?? 0));
  const outstanding = r2(
    Number(sched._sum.principalDue ?? 0) -
      Number(sched._sum.principalPaid ?? 0),
  );
  const penaltyCollected = r2(Number(sched._sum.penaltyPaid ?? 0));
  const netFees = r2(
    Number(feeAgg._sum.debit ?? 0) -
      Number(feeAgg._sum.credit ?? 0) +
      (Number(waiveAgg._sum.debit ?? 0) - Number(waiveAgg._sum.credit ?? 0)) -
      penaltyCollected,
  );
  const expected = r2(outstanding + netFees);
  const delta = r2(gl - expected);

  return {
    name: "receivable_subledger",
    ok: Math.abs(delta) <= TOLERANCE,
    delta,
    summary:
      Math.abs(delta) <= TOLERANCE
        ? `Loans Receivable agrees with the loan book at ${gl.toFixed(2)}.`
        : `LOANS RECEIVABLE OUT BY ${delta.toFixed(2)} — GL ${gl.toFixed(2)}, ` +
          `outstanding principal ${outstanding.toFixed(2)}, accrued fees ${netFees.toFixed(2)}.`,
  };
}
