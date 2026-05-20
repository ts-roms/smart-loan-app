export type Tier = 'A' | 'B' | 'C' | 'D' | 'F';

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
  if (score >= 750) return 'A';
  if (score >= 700) return 'B';
  if (score >= 600) return 'C';
  if (score >= 500) return 'D';
  return 'F';
}

export const TIER_LABEL: Record<Tier, string> = {
  A: 'Excellent',
  B: 'Good',
  C: 'Fair',
  D: 'Poor',
  F: 'Very poor',
};
