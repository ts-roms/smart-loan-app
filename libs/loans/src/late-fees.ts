/**
 * Late-fee policy. Pure function — given an installment and the as-of date,
 * computes the cumulative fee that *should* be on the books today.
 *
 * Default policy: 1% of the installment per full day overdue, capped at 10%.
 * Tune `DEFAULT_LATE_FEE_POLICY` or pass an override at the call site.
 *
 * The accrual job posts the *delta* between today's "should be" amount and
 * what's already accrued (idempotent per installment per day).
 */

export interface LateFeePolicy {
  /** Rate per day, e.g. 0.01 = 1% per day. */
  dailyRate: number;
  /** Maximum fraction of the installment that can ever accrue, e.g. 0.10 = 10%. */
  capFraction: number;
  /** Grace days where no fee accrues, e.g. 3 means days 1–3 are free. */
  graceDays: number;
}

export const DEFAULT_LATE_FEE_POLICY: LateFeePolicy = {
  dailyRate: 0.01,
  capFraction: 0.1,
  graceDays: 3,
};

/** Build a policy from a LoanProduct row. */
export function policyFromProduct(p: {
  lateFeeDailyRate?: number | string;
  lateFeeCapFraction?: number | string;
  lateFeeGraceDays?: number;
}): LateFeePolicy {
  return {
    dailyRate: Number(p.lateFeeDailyRate ?? DEFAULT_LATE_FEE_POLICY.dailyRate),
    capFraction: Number(
      p.lateFeeCapFraction ?? DEFAULT_LATE_FEE_POLICY.capFraction,
    ),
    graceDays: p.lateFeeGraceDays ?? DEFAULT_LATE_FEE_POLICY.graceDays,
  };
}

const DAY_MS = 86_400_000;

/**
 * Returns the full late fee that should be on the books for this installment
 * as of `asOf`. Floored at 0; never returns more than `capFraction * installment`.
 */
export function lateFeeFor(
  installment: { dueDate: Date; totalDue: number; paidInFullAt: Date | null },
  asOf: Date,
  policy: LateFeePolicy = DEFAULT_LATE_FEE_POLICY,
): number {
  if (installment.paidInFullAt) return 0;
  const overdueDays = Math.floor(
    (asOf.getTime() - installment.dueDate.getTime()) / DAY_MS,
  );
  const billableDays = Math.max(0, overdueDays - policy.graceDays);
  if (billableDays <= 0) return 0;
  const raw = installment.totalDue * policy.dailyRate * billableDays;
  const cap = installment.totalDue * policy.capFraction;
  return round2(Math.min(raw, cap));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
