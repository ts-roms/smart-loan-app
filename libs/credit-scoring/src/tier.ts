export type Tier = "A" | "B" | "C" | "D" | "F";

/**
 * Map a 300–850 numeric score to a letter tier. Thresholds:
 *
 *   A  ≥ 750   excellent — auto-approve candidates
 *   B  ≥ 700   good
 *   C  ≥ 600   fair — manual review territory
 *   D  ≥ 500   poor
 *   F  < 500   very poor — auto-reject candidates
 */
export function toTier(score: number): Tier {
  if (score >= 750) return "A";
  if (score >= 700) return "B";
  if (score >= 600) return "C";
  if (score >= 500) return "D";
  return "F";
}

export const TIER_LABEL: Record<Tier, string> = {
  A: "Excellent",
  B: "Good",
  C: "Fair",
  D: "Poor",
  F: "Very poor",
};

// ─── Bureau-style buckets (alignment) ────────────────────────────────────────
//
// The bureau-style scale uses 4 buckets instead of our 5-letter tiers. We expose both so
// the existing decisioning UI keeps its A–F tiers (used by per-tier pricing
// + LTV configs) while customer-facing reports and the application form can
// show the bureau-aligned label.
//
//   Excellent  ≥ 750
//   Good       ≥ 700
//   Fair       ≥ 650
//   Poor       < 650

export type BureauBucket = "EXCELLENT" | "GOOD" | "FAIR" | "POOR";

export function toBureauBucket(score: number): BureauBucket {
  if (score >= 750) return "EXCELLENT";
  if (score >= 700) return "GOOD";
  if (score >= 650) return "FAIR";
  return "POOR";
}

export const BUREAU_BUCKET_LABEL: Record<BureauBucket, string> = {
  EXCELLENT: "Excellent",
  GOOD: "Good",
  FAIR: "Fair",
  POOR: "Poor",
};

/** Minimum score for each bucket — useful for the legend on score cards. */
export const BUREAU_BUCKET_MIN: Record<BureauBucket, number> = {
  EXCELLENT: 750,
  GOOD: 700,
  FAIR: 650,
  POOR: 300,
};
