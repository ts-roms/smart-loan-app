/**
 * Loan product validation. Pure functions — given the product config
 * + the proposed application, return a list of issues. The API 400s
 * if any are present.
 *
 * Product configs live as DB rows (dynamic catalog). These helpers
 * only enforce the math + per-tier overrides.
 */

export type CollateralKind = "NONE" | "VEHICLE" | "PROPERTY";
export type InterestMethod = "DECLINING" | "FLAT";
export type PaymentFrequency = "MONTHLY" | "BIWEEKLY" | "WEEKLY";
export type CreditTier = "A" | "B" | "C" | "D" | "F";

/** Subset of LoanProduct columns the validator needs. */
export interface LoanProductConfig {
  code: string;
  collateralKind: CollateralKind;
  minPrincipal: number;
  maxPrincipal: number;
  minTermMonths: number;
  maxTermMonths: number;
  minRate: number;
  maxRate: number;
  /** Flat max LTV (used unless `ltvByTier` overrides). */
  maxLoanToValue: number | null;
  /** Per-tier rate overrides. Null entry = product not available for that tier. */
  rateByTier?: Partial<Record<CreditTier, number | null>> | null;
  /** Per-tier LTV overrides. */
  ltvByTier?: Partial<Record<CreditTier, number>> | null;
}

export interface ApplicationProposal {
  principal: number;
  termMonths: number;
  annualInterestRate: number;
  /** Required when `product.collateralKind` is VEHICLE or PROPERTY. */
  collateralAppraisedValue?: number;
  /** Customer's credit tier at apply, used for tier-based pricing checks. */
  tierAtApply?: CreditTier | null;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Returns empty array if the application passes the product's hard limits. */
export function validateLoanApplication(
  product: LoanProductConfig,
  input: ApplicationProposal,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (
    input.principal < product.minPrincipal ||
    input.principal > product.maxPrincipal
  ) {
    issues.push({
      field: "principal",
      message: `Principal must be between ${product.minPrincipal} and ${product.maxPrincipal} for ${product.code}.`,
    });
  }
  if (
    input.termMonths < product.minTermMonths ||
    input.termMonths > product.maxTermMonths
  ) {
    issues.push({
      field: "termMonths",
      message: `Term must be between ${product.minTermMonths} and ${product.maxTermMonths} months for ${product.code}.`,
    });
  }
  if (
    input.annualInterestRate < product.minRate ||
    input.annualInterestRate > product.maxRate
  ) {
    issues.push({
      field: "annualInterestRate",
      message: `Rate must be between ${pct(product.minRate)} and ${pct(product.maxRate)} for ${product.code}.`,
    });
  }

  // Tier-based pricing checks (only when the product has them configured).
  if (product.rateByTier && input.tierAtApply) {
    const tierRate = product.rateByTier[input.tierAtApply];
    if (tierRate === null) {
      issues.push({
        field: "tierAtApply",
        message: `${product.code} is not available for credit tier ${input.tierAtApply}.`,
      });
    } else if (
      tierRate !== undefined &&
      Math.abs(tierRate - input.annualInterestRate) > 0.0001
    ) {
      issues.push({
        field: "annualInterestRate",
        message: `Rate for tier ${input.tierAtApply} on ${product.code} is fixed at ${pct(tierRate)}.`,
      });
    }
  }

  if (product.collateralKind !== "NONE") {
    if (
      !input.collateralAppraisedValue ||
      input.collateralAppraisedValue <= 0
    ) {
      issues.push({
        field: "collateral",
        message: `${product.code} requires collateral with a positive appraised value.`,
      });
    } else {
      const ltvCap = effectiveMaxLtv(product, input.tierAtApply ?? null);
      if (ltvCap != null) {
        const ltv = input.principal / input.collateralAppraisedValue;
        if (ltv > ltvCap + 0.0001) {
          issues.push({
            field: "principal",
            message: `Loan-to-value ${pct(ltv)} exceeds ${pct(ltvCap)} ceiling for ${product.code}${input.tierAtApply ? ` (tier ${input.tierAtApply})` : ""}.`,
          });
        }
      }
    }
  }

  return issues;
}

/** Look up the rate this product offers a given tier. Falls back to defaultRate-style logic upstream. */
export function rateForTier(
  product: LoanProductConfig & { defaultRate?: number },
  tier: CreditTier | null,
): number | null {
  if (!tier || !product.rateByTier) return null;
  const v = product.rateByTier[tier];
  if (v === null) return null;
  return v ?? null;
}

/** Returns the effective LTV ceiling, respecting per-tier overrides. */
export function effectiveMaxLtv(
  product: LoanProductConfig,
  tier: CreditTier | null,
): number | null {
  if (tier && product.ltvByTier) {
    const tierLtv = product.ltvByTier[tier];
    if (tierLtv != null) return tierLtv;
  }
  return product.maxLoanToValue;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

// ─── Fee computation ───────────────────────────────────────────────

export interface FeeConfig {
  processingFeeRate: number;
  processingFeeFlat: number;
  documentaryStampRate: number;
}

export interface FeeBreakdown {
  processing: number;
  documentary: number;
  total: number;
  /** Principal less fees — the cash the customer actually receives. */
  netDisbursement: number;
}

export function computeFees(principal: number, fees: FeeConfig): FeeBreakdown {
  const processing = round2(
    principal * fees.processingFeeRate + fees.processingFeeFlat,
  );
  const documentary = round2(principal * fees.documentaryStampRate);
  const total = round2(processing + documentary);
  return {
    processing,
    documentary,
    total,
    netDisbursement: round2(principal - total),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Default product seed (used by seedDefaults) ───────────────────

export const DEFAULT_PRODUCTS: ReadonlyArray<{
  code: string;
  name: string;
  description: string;
  collateralKind: CollateralKind;
  requiredKycDocs: string[];
  minPrincipal: number;
  maxPrincipal: number;
  minTermMonths: number;
  maxTermMonths: number;
  defaultRate: number;
  minRate: number;
  maxRate: number;
  maxLoanToValue: number | null;
  processingFeeRate: number;
  processingFeeFlat: number;
  documentaryStampRate: number;
  lateFeeDailyRate: number;
  lateFeeCapFraction: number;
  lateFeeGraceDays: number;
  preTerminationFeeRate: number;
  interestMethod: InterestMethod;
  paymentFrequency: PaymentFrequency;
}> = [
  {
    code: "SALARY",
    name: "Salary Loan",
    description: "Short-term unsecured loan for employed individuals.",
    collateralKind: "NONE",
    requiredKycDocs: [],
    minPrincipal: 5_000,
    maxPrincipal: 500_000,
    minTermMonths: 3,
    maxTermMonths: 36,
    defaultRate: 0.24,
    minRate: 0.12,
    maxRate: 0.36,
    maxLoanToValue: null,
    processingFeeRate: 0.02,
    processingFeeFlat: 0,
    documentaryStampRate: 0.0075,
    lateFeeDailyRate: 0.01,
    lateFeeCapFraction: 0.1,
    lateFeeGraceDays: 3,
    preTerminationFeeRate: 0.02,
    interestMethod: "DECLINING",
    paymentFrequency: "MONTHLY",
  },
  {
    code: "MOTORCYCLE",
    name: "Motorcycle Loan",
    description: "Secured by the motorcycle being financed.",
    collateralKind: "VEHICLE",
    requiredKycDocs: ["VEHICLE_OR", "VEHICLE_CR"],
    minPrincipal: 20_000,
    maxPrincipal: 300_000,
    minTermMonths: 6,
    maxTermMonths: 36,
    defaultRate: 0.18,
    minRate: 0.12,
    maxRate: 0.24,
    maxLoanToValue: 0.8,
    processingFeeRate: 0.015,
    processingFeeFlat: 500,
    documentaryStampRate: 0.0075,
    lateFeeDailyRate: 0.01,
    lateFeeCapFraction: 0.1,
    lateFeeGraceDays: 3,
    preTerminationFeeRate: 0.03,
    interestMethod: "DECLINING",
    paymentFrequency: "MONTHLY",
  },
  {
    code: "AUTOMOTIVE",
    name: "Auto Loan",
    description: "Secured by the car being financed.",
    collateralKind: "VEHICLE",
    requiredKycDocs: ["VEHICLE_OR", "VEHICLE_CR"],
    minPrincipal: 100_000,
    maxPrincipal: 2_000_000,
    minTermMonths: 12,
    maxTermMonths: 60,
    defaultRate: 0.12,
    minRate: 0.08,
    maxRate: 0.18,
    maxLoanToValue: 0.8,
    processingFeeRate: 0.01,
    processingFeeFlat: 2_000,
    documentaryStampRate: 0.0075,
    lateFeeDailyRate: 0.005,
    lateFeeCapFraction: 0.1,
    lateFeeGraceDays: 5,
    preTerminationFeeRate: 0.05,
    interestMethod: "DECLINING",
    paymentFrequency: "MONTHLY",
  },
  {
    code: "HOUSING",
    name: "Housing Loan",
    description: "Long-term loan secured by real estate.",
    collateralKind: "PROPERTY",
    requiredKycDocs: ["PROPERTY_TITLE", "TAX_DECLARATION"],
    minPrincipal: 500_000,
    maxPrincipal: 10_000_000,
    minTermMonths: 60,
    maxTermMonths: 300,
    defaultRate: 0.08,
    minRate: 0.06,
    maxRate: 0.12,
    maxLoanToValue: 0.8,
    processingFeeRate: 0.005,
    processingFeeFlat: 5_000,
    documentaryStampRate: 0.0075,
    lateFeeDailyRate: 0.003,
    lateFeeCapFraction: 0.1,
    lateFeeGraceDays: 7,
    preTerminationFeeRate: 0.05,
    interestMethod: "DECLINING",
    paymentFrequency: "MONTHLY",
  },
];
