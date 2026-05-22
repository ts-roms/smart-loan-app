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

function decliningSchedule(
  principal: number,
  periodRate: number,
  periodCount: number,
): AmortizationRow[] {
  const payment = monthlyPayment(principal, periodRate, periodCount);
  const out: AmortizationRow[] = [];
  let balance = principal;
  for (let i = 1; i <= periodCount; i++) {
    const interest = balance * periodRate;
    let principalDue = payment - interest;
    if (i === periodCount) principalDue = balance;
    balance = Math.max(0, balance - principalDue);
    out.push({
      installmentNo: i,
      principal: round2(principalDue),
      interest: round2(interest),
      payment: round2(principalDue + interest),
      balance: round2(balance),
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
