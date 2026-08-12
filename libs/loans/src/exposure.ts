/**
 * Consolidated customer exposure — everything one borrower owes the
 * lender, across every loan they hold.
 *
 * Underwriting a fifth loan on the strength of the fourth one's balance
 * is how a coop ends up ₱2.1M into a member it believed it was ₱50,000
 * into. DTI, approval limits and portfolio concentration are all
 * questions about the BORROWER, not about a loan, and until they are
 * answered from one number nobody can say what that number is.
 *
 * Pure, and folded from figures the schedule-balance helpers already
 * produce: `loanBalance` / `balanceFromTotals` own the "what is left on
 * this loan" arithmetic and this module never recomputes it. A second
 * balance calculation that drifted from the first would show an officer
 * one exposure on the profile and a different one on the loan page,
 * which is worse than showing neither.
 *
 * ─── Which loans count ──────────────────────────────────────────────
 *
 * COUNTED — APPROVED, DISBURSED, ACTIVE, DEFAULTED. Money is either out
 *   the door or committed to go out, and the lender still expects it
 *   back. DEFAULTED especially: the borrower has stopped paying, not
 *   stopped owing, and dropping it would make the worst account on the
 *   book the one that reads cleanest.
 *
 * NOT COUNTED, and why each:
 *
 *   DRAFT / SUBMITTED / UNDER_REVIEW — nothing has been granted. Counting
 *     an application as exposure would let a borrower inflate their own
 *     recorded debt by filing forms.
 *   REJECTED / CANCELLED — never became loans.
 *   CLOSED — repaid in full; the receivable is gone. A settled loan
 *     contributes ₱0 by arithmetic anyway, so excluding it changes no
 *     total; it stays out so a borrower with twenty clean loans doesn't
 *     read as twenty live exposures in `activeLoans`.
 *   RESTRUCTURED — terminal because a NEW loan replaced it, and that
 *     successor is in the list too. Counting both would double the debt
 *     of every borrower who has ever been worked out.
 *   WRITTEN_OFF — the judgement call, and the honest answer is that it
 *     depends on what "exposure" is for. The lender has abandoned
 *     collection and booked the principal to Bad Debt: the receivable
 *     is off the books, the loss is already taken, and adding it to a
 *     live-exposure total would double-count money that has already
 *     been expensed. So it is excluded from `total`.
 *
 *     But it is the single most important fact about the borrower, and
 *     an exposure report that silently drops it is how a written-off
 *     member gets lent to again. It is therefore reported in
 *     `excluded` — count and principal both — so the figure is visible
 *     to whoever is deciding, without contaminating the receivable.
 *
 *     Choosing to include it in `total` would be defensible for a
 *     recovery-oriented view; what would not be defensible is dropping
 *     the rows entirely, which is the outcome this split exists to
 *     prevent.
 */

import type { LoanBalance } from "./schedule-balance";

/** Statuses whose balance counts toward live exposure. See above. */
export const EXPOSURE_STATUSES = [
  "APPROVED",
  "DISBURSED",
  "ACTIVE",
  "DEFAULTED",
] as const;

export type ExposureStatus = (typeof EXPOSURE_STATUSES)[number];

/** One of the borrower's loans, as the exposure fold needs it. */
export interface ExposureLoanInput {
  loanId: string;
  loanNumber: string;
  productCode: string;
  /** Display name from the product catalog, when the caller has it. */
  productName?: string | null;
  status: string;
  /** Contracted principal — what the loan was written for. */
  principal: number | string;
  /**
   * The loan's position, from `loanBalance` or `balanceFromTotals`.
   * Null when no schedule exists yet, which is not the same as zero —
   * see `loanExposure` for what happens then.
   */
  balance: LoanBalance | null;
  /**
   * The SAME fold, run over only those instalments that are unpaid and
   * already past their due date. Its `outstanding` is the arrears
   * amount and its `totalInstallments` is the count of instalments in
   * arrears — which is why this is a `LoanBalance` and not a bare
   * number: reusing the fold means past-due and outstanding can never
   * disagree about how a partly-settled instalment is treated.
   *
   * Null when the loan has no schedule.
   */
  overdue: LoanBalance | null;
}

/** One line of the consolidated view. */
export interface ExposureLoan {
  loanId: string;
  loanNumber: string;
  productCode: string;
  productName: string | null;
  status: string;
  principal: number;
  /** Principal still owed. */
  principalOutstanding: number;
  /** Principal plus scheduled interest still owed. */
  outstanding: number;
  /** Unpaid and past its due date. */
  pastDue: number;
  /** How many instalments make up `pastDue`. */
  overdueInstallments: number;
  /** Whether this row's figures are inside `total`. */
  counted: boolean;
  /**
   * False when the loan has no schedule and the figures fall back to
   * the contracted principal — see `loanExposure`.
   */
  fromSchedule: boolean;
}

export interface ExposureTotals {
  /** The headline: total principal this borrower still owes. */
  principalOutstanding: number;
  /** The same debt including scheduled interest. */
  outstanding: number;
  pastDue: number;
  /** How many loans the totals are made of. */
  activeLoans: number;
}

/**
 * Loans deliberately outside `total`, reported rather than dropped.
 * Zeroes here are meaningful — they say "we looked, there are none".
 */
export interface ExposureExcluded {
  /** Rows present in `loans` but not summed into `total`. */
  loans: number;
  closedLoans: number;
  writtenOffLoans: number;
  /** Principal the lender already expensed to Bad Debt. */
  writtenOffPrincipal: number;
}

export interface ConsolidatedExposure {
  /** Every loan the caller handed over, counted or not. */
  loans: ExposureLoan[];
  total: ExposureTotals;
  excluded: ExposureExcluded;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const num = (value: number | string): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : 0;
};

const counts = (status: string): boolean =>
  (EXPOSURE_STATUSES as readonly string[]).includes(status);

/**
 * One loan's contribution to the consolidated view.
 *
 * The schedule is the source of truth wherever there is one. Where
 * there isn't — an APPROVED loan whose schedule is written at
 * disbursement — the contracted principal stands in, because the
 * alternative is reporting ₱0 exposure against money the lender has
 * already committed to hand over, and understating exposure is the one
 * failure this whole module exists to prevent. `fromSchedule` marks
 * those rows so nothing downstream mistakes a commitment for a
 * receivable. Same fallback shape as `ledgerPositions`' unknown
 * obligation, and for the same reason.
 *
 * Rounded here, at the row, so the totals below are a sum of the
 * figures actually displayed. Summing raw and rounding once would let a
 * panel's visible rows add up to something other than its visible
 * total, which reads as a bug in the arithmetic every time.
 */
export function loanExposure(input: ExposureLoanInput): ExposureLoan {
  const principal = round2(num(input.principal));
  const balance = input.balance;

  const principalOutstanding = balance
    ? round2(balance.principalOutstanding)
    : principal;
  const outstanding = balance ? round2(balance.outstanding) : principal;

  return {
    loanId: input.loanId,
    loanNumber: input.loanNumber,
    productCode: input.productCode,
    productName: input.productName ?? null,
    status: input.status,
    principal,
    principalOutstanding,
    outstanding,
    // No schedule means nothing can be past due yet: there is no
    // instalment to have missed.
    pastDue: input.overdue ? round2(input.overdue.outstanding) : 0,
    overdueInstallments: input.overdue ? input.overdue.totalInstallments : 0,
    counted: counts(input.status),
    fromSchedule: balance !== null,
  };
}

/**
 * Fold a borrower's whole book into one exposure.
 *
 * Every loan handed in comes back in `loans`, including the ones that
 * don't count — an exposure report an officer can't reconcile against
 * the loan list is an exposure report they won't trust. `counted` says
 * which rows are inside `total`.
 */
export function consolidatedExposure(
  loans: readonly ExposureLoanInput[],
): ConsolidatedExposure {
  const rows = loans.map(loanExposure);

  const total: ExposureTotals = {
    principalOutstanding: 0,
    outstanding: 0,
    pastDue: 0,
    activeLoans: 0,
  };
  const excluded: ExposureExcluded = {
    loans: 0,
    closedLoans: 0,
    writtenOffLoans: 0,
    writtenOffPrincipal: 0,
  };

  for (const row of rows) {
    if (row.counted) {
      total.principalOutstanding += row.principalOutstanding;
      total.outstanding += row.outstanding;
      total.pastDue += row.pastDue;
      total.activeLoans += 1;
      continue;
    }

    excluded.loans += 1;
    if (row.status === "CLOSED") excluded.closedLoans += 1;
    if (row.status === "WRITTEN_OFF") {
      excluded.writtenOffLoans += 1;
      // The contracted principal, not the balance: a written-off loan's
      // schedule is whatever it was when collection stopped, while the
      // amount that went to Bad Debt is what the lender put out.
      excluded.writtenOffPrincipal += row.principal;
    }
  }

  // Re-rounded after summing: adding a dozen two-decimal values in
  // binary floating point lands a few millionths off, and an exposure
  // figure ending in 0.0000000001 discredits the whole panel.
  total.principalOutstanding = round2(total.principalOutstanding);
  total.outstanding = round2(total.outstanding);
  total.pastDue = round2(total.pastDue);
  excluded.writtenOffPrincipal = round2(excluded.writtenOffPrincipal);

  return { loans: rows, total, excluded };
}
