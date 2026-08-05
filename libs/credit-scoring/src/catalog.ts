/**
 * Tenant-editable scoring catalog.
 *
 * The factor list and the survey questions used to be constants in
 * factors.ts. They're now rows an admin can create, edit and remove —
 * but the SCALE is not editable, and that distinction is the whole
 * design.
 *
 * ## Why the total is pinned
 *
 * A raw score is the sum of per-factor points, mapped linearly onto
 * 300–850. If admins set point values directly, adding a factor grows
 * the raw total and every existing score silently means something
 * different: decision rules that say `creditScoreAtApply >= 700` start
 * admitting a different population, and tiers shift under borrowers
 * nobody re-assessed.
 *
 * So admins set a relative WEIGHT per factor, and this module
 * normalizes those weights onto a fixed {@link TOTAL_RAW_POINTS}. Add a
 * factor and the others give up points to make room; remove one and
 * they take them back. The scale never moves, so a 720 means the same
 * thing before and after an edit, and rule thresholds keep their
 * meaning.
 *
 * Weights are arbitrary positive numbers — 25 and 20, or 5 and 4, or
 * 0.25 and 0.2, all describe the same split. Only their ratio matters.
 */

import type { SurveyQuestion } from "./factors";

/**
 * The fixed raw-score ceiling. Chosen to match the historical catalog
 * (survey 100 + behavioural 50) so scores computed before the catalog
 * became editable remain directly comparable with ones computed after.
 * Changing this constant WOULD move the scale — it's deliberately not
 * configurable.
 */
export const TOTAL_RAW_POINTS = 150;

export interface CatalogFactor {
  /** Stable key referenced by questions and by stored breakdowns. */
  id: string;
  label: string;
  /**
   * Relative share of the total. Any positive number; only the ratio
   * between factors matters.
   */
  weight: number;
  /**
   * True for factors derived from loan history (on-time rate, defaults)
   * rather than from a survey answer. They still consume points, so
   * they participate in normalization like any other factor.
   */
  computed?: boolean;
}

export interface ScoringCatalog {
  factors: CatalogFactor[];
  questions: SurveyQuestion[];
}

/** A factor with its normalized point value resolved. */
export interface ResolvedFactor extends CatalogFactor {
  maxPoints: number;
}

/**
 * Normalize weights onto exactly {@link TOTAL_RAW_POINTS}.
 *
 * Uses largest-remainder apportionment rather than plain rounding:
 * rounding each share independently can land the sum on 149 or 151, and
 * a raw total that disagrees with the constant would skew every score
 * by a fraction of a tier. Largest-remainder distributes the rounding
 * residue to the factors that lost the most to truncation, so the parts
 * sum to the whole exactly — the same method used for apportioning
 * seats to populations, and for the same reason.
 *
 * Degenerate input (no factors, or weights summing to zero) yields an
 * empty result rather than dividing by zero: a catalog with nothing in
 * it scores nothing, which the caller surfaces as an un-scoreable
 * survey instead of a crash.
 */
export function resolveFactorPoints(
  factors: CatalogFactor[],
): ResolvedFactor[] {
  const usable = factors.filter((f) => f.weight > 0);
  const totalWeight = usable.reduce((sum, f) => sum + f.weight, 0);
  if (usable.length === 0 || totalWeight <= 0) return [];

  const exact = usable.map((f) => ({
    factor: f,
    ideal: (f.weight / totalWeight) * TOTAL_RAW_POINTS,
  }));

  const floored = exact.map((e) => ({ ...e, points: Math.floor(e.ideal) }));
  let remaining = TOTAL_RAW_POINTS - floored.reduce((s, f) => s + f.points, 0);

  // Hand the leftover points to the biggest fractional losers first.
  // Ties break on the earlier factor, so the result is deterministic —
  // the same catalog always resolves to the same points, which matters
  // because these numbers end up in stored breakdowns.
  const byRemainder = [...floored].sort(
    (a, b) => b.ideal - b.points - (a.ideal - a.points),
  );
  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    entry.points += 1;
    remaining -= 1;
  }

  return floored.map((e) => ({ ...e.factor, maxPoints: e.points }));
}
