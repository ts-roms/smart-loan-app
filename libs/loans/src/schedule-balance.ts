/**
 * Balance arithmetic over a loan's *persisted* schedule.
 *
 * Distinct from the projection math in index.ts. `computeAmortization`
 * answers "what will the instalments be" from principal, rate and term;
 * everything here answers "where does this loan actually stand" from the
 * LoanSchedule rows, which carry what has since been paid against each
 * one.
 *
 * It lives in the shared lib rather than in the UI because three places
 * need the same number — the borrower's dashboard, the loan detail
 * panel, and the statement PDF — and a borrower being shown two
 * different balances for the same loan is the kind of bug that costs
 * trust rather than a bug report.
 *
 * Decimal columns arrive from Prisma as strings over the wire, so every
 * input is coerced rather than trusted.
 */

/** The subset of a LoanSchedule row the balance math needs. */
export interface ScheduleRowInput {
  principalDue: number | string;
  interestDue: number | string;
  totalDue: number | string;
  principalPaid: number | string;
  interestPaid: number | string;
  paidInFullAt?: string | Date | null;
}

export interface LoanBalance {
  /** Contractual total across every instalment: principal + interest. */
  scheduled: number;
  /** Everything credited so far, principal and interest together. */
  paid: number;
  /** `scheduled - paid`, floored at zero. What's left to hand over. */
  outstanding: number;
  /** Principal only — the figure a payoff quote is built from. */
  principalScheduled: number;
  principalPaid: number;
  principalOutstanding: number;
  paidInstallments: number;
  totalInstallments: number;
}

const n = (value: number | string): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Floor at zero to absorb float dust. Summing a dozen two-decimal
 * strings can land a few millionths below zero on a fully-settled loan,
 * and "-₱0.00" on a borrower's dashboard reads as a bug in the lender's
 * favour.
 */
const atLeastZero = (value: number): number => Math.max(0, value);

/** Fold a loan's schedule into its current position. */
export function loanBalance(rows: readonly ScheduleRowInput[]): LoanBalance {
  let scheduled = 0;
  let paid = 0;
  let principalScheduled = 0;
  let principalPaid = 0;
  let paidInstallments = 0;

  for (const row of rows) {
    scheduled += n(row.totalDue);
    paid += n(row.principalPaid) + n(row.interestPaid);
    principalScheduled += n(row.principalDue);
    principalPaid += n(row.principalPaid);
    if (row.paidInFullAt) paidInstallments += 1;
  }

  return {
    scheduled,
    paid,
    outstanding: atLeastZero(scheduled - paid),
    principalScheduled,
    principalPaid,
    principalOutstanding: atLeastZero(principalScheduled - principalPaid),
    paidInstallments,
    totalInstallments: rows.length,
  };
}

/**
 * Same fold, but from pre-aggregated sums.
 *
 * A list endpoint can't afford to pull every schedule row for every loan
 * on the page — a 360-month loan is 360 rows, and 200 of those is 72,000
 * rows to ship and fold for a table showing one number per loan. The
 * repositories therefore let Postgres do the summing (`groupBy` +
 * `_sum`) and hand the totals here, so the flooring and derivation rules
 * still live in exactly one place.
 */
export function balanceFromTotals(totals: {
  scheduled: number;
  paid: number;
  principalScheduled: number;
  principalPaid: number;
  paidInstallments: number;
  totalInstallments: number;
}): LoanBalance {
  return {
    scheduled: totals.scheduled,
    paid: totals.paid,
    outstanding: atLeastZero(totals.scheduled - totals.paid),
    principalScheduled: totals.principalScheduled,
    principalPaid: totals.principalPaid,
    principalOutstanding: atLeastZero(
      totals.principalScheduled - totals.principalPaid,
    ),
    paidInstallments: totals.paidInstallments,
    totalInstallments: totals.totalInstallments,
  };
}

export interface RunningBalanceRow {
  /**
   * Contractual principal still outstanding after this instalment,
   * assuming every instalment up to it was paid exactly on schedule.
   * This is what an amortization table conventionally means, and what
   * "how much will I still owe after March?" is asking.
   */
  scheduledBalance: number;
  /**
   * Principal still outstanding given what has *actually* been paid, as
   * of this row. Ahead of schedule it sits below `scheduledBalance`;
   * behind, above it.
   *
   * It stops declining once payments stop, which is the point — a
   * borrower four instalments behind sees the balance flatten out
   * exactly where they stopped paying, rather than a contractual line
   * that keeps marching down as though nothing were wrong.
   */
  actualBalance: number;
}

/**
 * Per-instalment running balances, both contractual and actual.
 *
 * Returned as a parallel array rather than merged into the caller's rows
 * so this stays usable from the UI, the PDF renderer and anything else,
 * none of which agree on a row shape.
 */
export function runningBalances(
  rows: readonly ScheduleRowInput[],
  openingPrincipal: number | string,
): RunningBalanceRow[] {
  let scheduledBalance = n(openingPrincipal);
  let actualBalance = n(openingPrincipal);

  return rows.map((row) => {
    scheduledBalance -= n(row.principalDue);
    actualBalance -= n(row.principalPaid);
    return {
      scheduledBalance: atLeastZero(scheduledBalance),
      actualBalance: atLeastZero(actualBalance),
    };
  });
}
