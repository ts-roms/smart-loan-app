import { type PrismaClient } from "@loan/db";

/**
 * Anomaly flag returned by computeAnomalyFlags(). Codes are stable
 * (audit log + UI rendering depends on them); messages are human copy
 * that may be tweaked freely.
 */
export interface AnomalyFlag {
  code:
    | "PRINCIPAL_OUTLIER"
    | "TERM_OUTLIER"
    | "RATE_OUTLIER"
    | "APPLICANT_VELOCITY"
    | "PRINCIPAL_TO_INCOME"
    | "INSUFFICIENT_BASELINE";
  severity: "low" | "medium" | "high";
  message: string;
  /** Z-score for outlier flags. Null for non-stats checks. */
  zScore: number | null;
  /** The observed value being flagged. */
  observed: number | null;
  /** The mean of the historical baseline (for outlier flags). */
  baseline: number | null;
}

export interface AnomalyContext {
  /**
   * The applicant, when they already have a Customer row. Omitted when
   * pre-assessing a walk-in prospect: there's no prior history to exclude
   * from the baseline, and no application velocity to count.
   */
  customerId?: string;
  productCode: string;
  principal: number;
  termMonths: number;
  /** Annual rate as a decimal (0.24 = 24% APR). */
  annualInterestRate: number;
  /** Borrower's monthly income — used for principal-to-income ratio check. */
  monthlyIncome: number;
}

/**
 * Minimum number of historical samples before a z-score is considered
 * meaningful. Below this, we skip outlier checks (and emit a single
 * INSUFFICIENT_BASELINE flag for transparency in the UI).
 */
const MIN_SAMPLES_FOR_STATS = 10;

/**
 * Z-score absolute value at which to flag the application. 2.0 ≈ 2σ
 * (top/bottom ~2.5% per tail under normality). The product has to be
 * VERY unusual to trip this — most legitimate-but-large loans land
 * around 1σ and stay quiet.
 */
const Z_SCORE_THRESHOLD_MEDIUM = 2.0;
const Z_SCORE_THRESHOLD_HIGH = 3.0;

/**
 * Pure-stats anomaly flagger. Compares an in-flight loan application
 * against the historical distribution of the same product, plus a
 * couple of domain-specific sanity checks (applicant velocity,
 * principal-to-income ratio).
 *
 * All checks are independent — a single application can collect
 * multiple flags. Order in the returned array is stable (sorted by
 * severity descending) so the UI can render them top-down.
 */
export async function computeAnomalyFlags(
  prisma: PrismaClient,
  ctx: AnomalyContext,
): Promise<AnomalyFlag[]> {
  const flags: AnomalyFlag[] = [];

  // ── Historical baseline for this product ────────────────────────
  // Cap at the last 500 loans of this product; we only need enough
  // for a stable mean+stddev. Excluding DRAFT/REJECTED keeps the
  // baseline aligned with "what we actually book" rather than what
  // people ask for.
  const historical = await prisma.loanApplication.findMany({
    where: {
      productCode: ctx.productCode,
      status: {
        in: ["SUBMITTED", "APPROVED", "DISBURSED", "ACTIVE", "CLOSED"],
      },
      // Exclude the applicant's own history so they aren't compared
      // against themselves. Nothing to exclude for a prospect.
      customerId: ctx.customerId ? { not: ctx.customerId } : undefined,
    },
    select: { principal: true, termMonths: true, annualInterestRate: true },
    orderBy: { submittedAt: "desc" },
    take: 500,
  });

  if (historical.length < MIN_SAMPLES_FOR_STATS) {
    flags.push({
      code: "INSUFFICIENT_BASELINE",
      severity: "low",
      message: `Only ${historical.length} prior ${ctx.productCode} loan(s) in the dataset — outlier stats are skipped until baseline reaches ${MIN_SAMPLES_FOR_STATS}.`,
      zScore: null,
      observed: null,
      baseline: null,
    });
  } else {
    const principals = historical.map((l) => Number(l.principal));
    const terms = historical.map((l) => l.termMonths);
    const rates = historical.map((l) => Number(l.annualInterestRate));

    const principalFlag = outlierFlag(
      "PRINCIPAL_OUTLIER",
      ctx.principal,
      principals,
      (v) => `₱${v.toLocaleString()}`,
      "principal",
    );
    if (principalFlag) flags.push(principalFlag);

    const termFlag = outlierFlag(
      "TERM_OUTLIER",
      ctx.termMonths,
      terms,
      (v) => `${v.toFixed(0)} months`,
      "term length",
    );
    if (termFlag) flags.push(termFlag);

    const rateFlag = outlierFlag(
      "RATE_OUTLIER",
      ctx.annualInterestRate,
      rates,
      (v) => `${(v * 100).toFixed(2)}%`,
      "interest rate",
    );
    if (rateFlag) flags.push(rateFlag);
  }

  // ── Applicant velocity ──────────────────────────────────────────
  // Count non-DRAFT applications by this customer in the last 30
  // days. 3+ within 30 days is unusual enough to surface.
  //
  // Skipped entirely for a prospect: with no Customer row there are no
  // applications to count, and running the query unscoped would count
  // everyone's.
  if (ctx.customerId) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentApps = await prisma.loanApplication.count({
      where: {
        customerId: ctx.customerId,
        submittedAt: { gte: thirtyDaysAgo },
        status: { not: "DRAFT" },
      },
    });
    if (recentApps >= 3) {
      flags.push({
        code: "APPLICANT_VELOCITY",
        severity: recentApps >= 5 ? "high" : "medium",
        message: `${recentApps} applications from this customer in the last 30 days. Review for stacking / fraud signals.`,
        zScore: null,
        observed: recentApps,
        baseline: 0,
      });
    }
  }

  // ── Principal-to-income ratio ───────────────────────────────────
  // Soft check: principal > 30× monthly income is unusual for any
  // unsecured product. Secured products (auto / mortgage) can
  // legitimately exceed this, but the flag is informational, not
  // blocking — the officer/decisioner has the final word.
  if (ctx.monthlyIncome > 0) {
    const ratio = ctx.principal / ctx.monthlyIncome;
    if (ratio > 30) {
      flags.push({
        code: "PRINCIPAL_TO_INCOME",
        severity: ratio > 60 ? "high" : "medium",
        message: `Principal is ${ratio.toFixed(1)}× monthly income — verify income documentation, especially for unsecured products.`,
        zScore: null,
        observed: ratio,
        baseline: 30,
      });
    }
  }

  // Sort: high → medium → low so the UI renders the most
  // important flag at the top of the list.
  const order: Record<AnomalyFlag["severity"], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);
  return flags;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Sample mean + corrected sample standard deviation. Returns `null`
 * stddev when fewer than 2 samples (undefined behaviour otherwise).
 */
function meanStddev(values: number[]): { mean: number; stddev: number | null } {
  const n = values.length;
  if (n === 0) return { mean: 0, stddev: null };
  const mean = values.reduce((a, v) => a + v, 0) / n;
  if (n < 2) return { mean, stddev: null };
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Generic outlier-flag builder. Computes z-score against the
 * historical samples; returns a flag only when |z| ≥ threshold.
 */
function outlierFlag(
  code: "PRINCIPAL_OUTLIER" | "TERM_OUTLIER" | "RATE_OUTLIER",
  observed: number,
  samples: number[],
  fmt: (v: number) => string,
  field: string,
): AnomalyFlag | null {
  const { mean, stddev } = meanStddev(samples);
  // Degenerate baseline (everyone applied for the same amount) —
  // can't compute z-score meaningfully.
  if (stddev === null || stddev === 0) return null;
  const z = (observed - mean) / stddev;
  const abs = Math.abs(z);
  if (abs < Z_SCORE_THRESHOLD_MEDIUM) return null;
  const severity = abs >= Z_SCORE_THRESHOLD_HIGH ? "high" : "medium";
  const direction = z > 0 ? "above" : "below";
  return {
    code,
    severity,
    message: `Requested ${field} ${fmt(observed)} is ${abs.toFixed(1)}σ ${direction} the product average of ${fmt(mean)}.`,
    zScore: Math.round(z * 100) / 100,
    observed,
    baseline: Math.round(mean * 100) / 100,
  };
}
