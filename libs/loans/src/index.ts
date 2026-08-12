/**
 * Amortization math. Two interest methods supported:
 *
 * - **DECLINING** (standard): fixed monthly payment, interest computed
 *   on the remaining balance each installment. The lender's view of
 *   "true" cost.
 *
 * - **FLAT** (add-on): interest is `principal × annualRate × years`
 *   computed once on the full principal, then `(principal + interest) /
 *   N` is the per-period payment. Common for short-term personal loans
 *   in PH because it's easy to explain ("you pay 1.5% per month flat").
 *   The effective APR is roughly *double* the flat rate for short terms.
 *
 * Payment frequency adds a second axis: monthly, bi-weekly (every 14 days),
 * or weekly. We convert `termMonths` to a period count and the annual rate
 * to a per-period rate before computing.
 */

export type InterestMethod = "DECLINING" | "FLAT";
export type PaymentFrequency = "MONTHLY" | "BIWEEKLY" | "WEEKLY";

export interface AmortizationOptions {
  /** Defaults to DECLINING for backward compat with the previous API. */
  method?: InterestMethod;
  /** Defaults to MONTHLY for backward compat. */
  frequency?: PaymentFrequency;
}

export interface AmortizationRow {
  installmentNo: number;
  /** Principal portion of this installment */
  principal: number;
  /** Interest portion of this installment */
  interest: number;
  /** Total payment (principal + interest) */
  payment: number;
  /** Remaining balance after this installment */
  balance: number;
}

/** Number of payment periods per year for each frequency. */
export function periodsPerYear(frequency: PaymentFrequency): number {
  switch (frequency) {
    case "MONTHLY":
      return 12;
    case "BIWEEKLY":
      return 26;
    case "WEEKLY":
      return 52;
  }
}

/** Days between installments for date scheduling. Approximate for monthly (use date math instead). */
export function daysBetweenInstallments(
  frequency: PaymentFrequency,
): number | "MONTH" {
  switch (frequency) {
    case "MONTHLY":
      return "MONTH";
    case "BIWEEKLY":
      return 14;
    case "WEEKLY":
      return 7;
  }
}

/**
 * Total number of installments for a given (term in months, frequency).
 * Monthly: term * 1. Bi-weekly: term * (26/12) ≈ 2.167. Weekly: term * (52/12) ≈ 4.333.
 * We round to the nearest whole installment count.
 */
export function installmentCount(
  termMonths: number,
  frequency: PaymentFrequency = "MONTHLY",
): number {
  if (frequency === "MONTHLY") return termMonths;
  if (frequency === "BIWEEKLY") return Math.round((termMonths * 26) / 12);
  return Math.round((termMonths * 52) / 12);
}

/** Standard fixed-payment amortization formula (declining balance). */
export function monthlyPayment(
  principal: number,
  periodRate: number,
  periodCount: number,
): number {
  if (periodRate === 0) return principal / periodCount;
  const r = periodRate;
  const n = periodCount;
  return (principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
}

/**
 * Build the amortization schedule. The previous signature
 * `computeAmortization(principal, monthlyRate, termMonths)` still works for
 * declining-monthly callers; pass `{ method, frequency }` for the new behaviour.
 *
 * `monthlyRate` for the legacy signature is the *per-period* rate — i.e.
 * `annualRate / 12`. Callers using the new path should pass the annual rate
 * via a different entry point (`computeAmortizationFor(annual, term, opts)`).
 */
export function computeAmortization(
  principal: number,
  periodRate: number,
  periodCount: number,
  opts: AmortizationOptions = {},
): AmortizationRow[] {
  const method = opts.method ?? "DECLINING";
  if (method === "FLAT")
    return flatSchedule(principal, periodRate, periodCount);
  return decliningSchedule(principal, periodRate, periodCount);
}

/** Convenience that handles the annual-rate→period-rate conversion. */
export function computeAmortizationFor(
  principal: number,
  annualRate: number,
  termMonths: number,
  opts: AmortizationOptions = {},
): AmortizationRow[] {
  const frequency = opts.frequency ?? "MONTHLY";
  const n = installmentCount(termMonths, frequency);
  const periodRate = annualRate / periodsPerYear(frequency);
  return computeAmortization(principal, periodRate, n, opts);
}

/**
 * Declining-balance schedule.
 *
 * Two balances are tracked deliberately:
 *
 * - `exactBalance` is unrounded and drives the interest math, so interest
 *   is computed on the true remaining principal (standard amortization);
 *   rounding each period first would compound the error across the term.
 * - `principalAccum` sums the *rounded* principal actually written to each
 *   row, and the final installment trues up against it.
 *
 * That second part is what makes the schedule reconcile. The rows are what
 * gets persisted to `LoanSchedule` and what the borrower actually pays, and
 * the loan is booked to Loans Receivable at full `principal` on
 * disbursement — so if the rounded rows don't sum to `principal`, paying
 * every installment in full leaves a permanent residual on the receivable.
 * `payment` is likewise derived from the rounded parts, upholding the
 * `totalDue = principalDue + interestDue` invariant that LoanSchedule
 * documents. `flatSchedule` below has always done this; declining didn't,
 * and drifted by up to ~1 peso on weekly terms.
 */
function decliningSchedule(
  principal: number,
  periodRate: number,
  periodCount: number,
): AmortizationRow[] {
  const payment = monthlyPayment(principal, periodRate, periodCount);
  const out: AmortizationRow[] = [];
  let exactBalance = principal;
  let principalAccum = 0;
  for (let i = 1; i <= periodCount; i++) {
    const isLast = i === periodCount;
    const interestRaw = exactBalance * periodRate;
    const principalRaw = isLast ? exactBalance : payment - interestRaw;
    exactBalance = Math.max(0, exactBalance - principalRaw);

    const interest = round2(interestRaw);
    // The last row absorbs the accumulated rounding drift so the rounded
    // principal column sums to exactly `principal`.
    const principalDue = isLast
      ? round2(principal - principalAccum)
      : round2(principalRaw);
    principalAccum = round2(principalAccum + principalDue);

    out.push({
      installmentNo: i,
      principal: principalDue,
      interest,
      payment: round2(principalDue + interest),
      balance: round2(principal - principalAccum),
    });
  }
  return out;
}

/**
 * Flat / add-on interest: total interest = principal × periodRate × periodCount.
 * Each installment gets an equal share of principal + an equal share of interest.
 * Last installment absorbs any rounding drift.
 */
function flatSchedule(
  principal: number,
  periodRate: number,
  periodCount: number,
): AmortizationRow[] {
  const totalInterest = principal * periodRate * periodCount;
  const principalPerPeriod = principal / periodCount;
  const interestPerPeriod = totalInterest / periodCount;

  const out: AmortizationRow[] = [];
  let balance = principal;
  let principalAccum = 0;
  let interestAccum = 0;
  for (let i = 1; i <= periodCount; i++) {
    let p = round2(principalPerPeriod);
    let interest = round2(interestPerPeriod);
    if (i === periodCount) {
      // Final installment absorbs rounding.
      p = round2(principal - principalAccum);
      interest = round2(totalInterest - interestAccum);
    }
    principalAccum += p;
    interestAccum += interest;
    balance = Math.max(0, round2(balance - p));
    out.push({
      installmentNo: i,
      principal: p,
      interest,
      payment: round2(p + interest),
      balance,
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export * from "./products";
export * from "./late-fees";
// Balance arithmetic over a *persisted* schedule — where a loan actually
// stands, as opposed to the projection math above.
export * from "./schedule-balance";

export {
  RENEWABLE_STATUSES,
  checkRenewal,
  renewalNetProceeds,
  type RenewalCheck,
  type RenewalCheckInput,
} from "./renewal";

// One borrower's whole book, folded into a single obligation. Built on
// schedule-balance above rather than beside it.
export {
  consolidatedExposure,
  loanExposure,
  EXPOSURE_STATUSES,
  type ConsolidatedExposure,
  type ExposureExcluded,
  type ExposureLoan,
  type ExposureLoanInput,
  type ExposureStatus,
  type ExposureTotals,
} from "./exposure";

export {
  ledgerPositions,
  type LedgerPositionKind,
  type PositionEntryInput,
  type PositionResult,
} from "./ledger-position";

export {
  agentBookTotals,
  assertValidCommissionRate,
  quoteCommission,
  COMMISSION_EARNED_STATUSES,
  InvalidCommissionRateError,
  MAX_COMMISSION_RATE,
  type AgentBookRow,
  type AgentBookTotals,
  type CommissionInput,
  type CommissionQuote,
  type CommissionRateSource,
} from "./agent-commission";

export {
  assertPayoutBalances,
  buildPayout,
  selectPayable,
  NothingPayableError,
  PayoutMismatchError,
  type PayableLoan,
  type PayableSelection,
  type PayoutDraft,
} from "./agent-payout";
