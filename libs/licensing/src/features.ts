/**
 * Default feature catalog per tier. The issue-license CLI uses these
 * unless `--features` is passed explicitly. Each tier is a strict
 * superset of the previous, so we just spread.
 *
 * Treat this file as the price-list source of truth. If marketing
 * shifts what BASIC includes, change it here — the platform CLI and
 * the in-app status panel both read from this.
 */

import type { FeatureFlag, LicenseTier } from "./types";

const BASIC_FEATURES: FeatureFlag[] = [
  "core.customers",
  "core.loans",
  "core.kyc",
  "core.scoring",
  "accounting.gl",
];

const PROFESSIONAL_FEATURES: FeatureFlag[] = [
  ...BASIC_FEATURES,
  "servicing.collections",
  "servicing.demand_letters",
  "servicing.repossession",
  "servicing.lease",
  "accounting.periods",
  "accounting.reconciliation",
  "compliance.annual_docs",
  "compliance.reports",
  "bulk.customers",
  "bulk.payments",
];

const ENTERPRISE_FEATURES: FeatureFlag[] = [
  ...PROFESSIONAL_FEATURES,
  "accounting.ecl",
  "cooperative.contributions",
  "cooperative.savings",
  "cooperative.funds",
  "compliance.dorsi",
  "intel.ai_assistant",
  "intel.id_ocr",
  "intel.face_match",
  "intel.anomaly_flags",
  "bulk.users",
];

export const TIER_FEATURES: Record<LicenseTier, FeatureFlag[]> = {
  BASIC: BASIC_FEATURES,
  PROFESSIONAL: PROFESSIONAL_FEATURES,
  ENTERPRISE: ENTERPRISE_FEATURES,
};

/** Default feature set for a tier. Copies so callers can mutate. */
export function defaultFeaturesForTier(tier: LicenseTier): FeatureFlag[] {
  return [...TIER_FEATURES[tier]];
}

/**
 * Default seat caps per tier. 0 = unlimited. These are intentionally
 * generous; the seat check is a soft guard for the operator, not a
 * piracy-grade limit. (The signature is the real control.)
 */
export const TIER_SEATS: Record<LicenseTier, number> = {
  BASIC: 10,
  PROFESSIONAL: 50,
  ENTERPRISE: 0,
};
