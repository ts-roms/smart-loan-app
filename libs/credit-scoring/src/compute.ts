import {
  resolveFactorPoints,
  TOTAL_RAW_POINTS,
  type ResolvedFactor,
  type ScoringCatalog,
} from "./catalog";
import {
  FACTORS,
  SURVEY_QUESTIONS,
  type SurveyAnswer,
  type SurveyQuestion,
} from "./factors";
import { toBureauBucket, toTier, type BureauBucket, type Tier } from "./tier";

export interface BehaviorInput {
  priorLoans: number;
  defaults: number;
  onTimeRate: number | null;
}

export interface FactorBreakdown {
  factorId: string;
  label: string;
  maxPoints: number;
  /** Weight applied (0..1). */
  weight: number;
  /** maxPoints * weight (rounded). */
  points: number;
  /** Friendly source description for explainability. */
  source: string;
}

export interface CreditScoreResult {
  /** Final score in the 300–850 range. */
  score: number;
  /** Internal 5-letter tier used by per-tier pricing and LTV configs. */
  tier: Tier;
  /** Bureau-style 4-bucket label (: Excellent/Good/Fair/Poor). */
  bucket: BureauBucket;
  /** Sum of every factor's points before scaling. */
  rawScore: number;
  /** Max possible raw score. */
  maxRaw: number;
  breakdown: FactorBreakdown[];
}

/**
 * The catalog as shipped, used when no tenant catalog is supplied.
 *
 * Weights ARE the historical maxPoints, and they already sum to 150, so
 * normalization is a no-op on them — a deployment that never touches
 * the catalog scores exactly as it always did.
 */
export const DEFAULT_CATALOG: ScoringCatalog = {
  factors: FACTORS.map((f) => ({
    id: f.id,
    label: f.label,
    weight: f.maxPoints,
    computed: f.id === "on_time" || f.id === "defaults",
  })),
  questions: SURVEY_QUESTIONS,
};

/**
 * Compute a credit score from survey answers + behavioral history.
 *
 * Survey-driven factors look up their weight from the question catalog;
 * behavioral factors (on-time payments, defaults) are derived directly
 * from `behavior`. Missing answers contribute 0 — they don't crash.
 *
 * `catalog` is the tenant's editable factor + question set. Factor
 * point values are DERIVED from relative weights against a fixed total
 * (see catalog.ts), so an admin adding or removing a factor
 * redistributes points rather than moving the 300–850 scale — a 720
 * means the same thing before and after an edit, and decision rules
 * that threshold on score keep their meaning.
 */
export function computeCreditScore(input: {
  answers: Record<string, SurveyAnswer>;
  behavior?: BehaviorInput;
  catalog?: ScoringCatalog;
}): CreditScoreResult {
  const { answers, behavior } = input;
  const catalog = input.catalog ?? DEFAULT_CATALOG;
  const resolved = resolveFactorPoints(catalog.factors);
  const breakdown: FactorBreakdown[] = [];

  // Survey factors.
  for (const q of catalog.questions) {
    const factor = resolved.find((f) => f.id === q.factorId);
    if (!factor) continue;
    const { weight, source } = evaluateQuestion(q, answers[q.id]);
    breakdown.push({
      factorId: factor.id,
      label: factor.label,
      maxPoints: factor.maxPoints,
      weight,
      points: Math.round(factor.maxPoints * weight),
      source,
    });
  }

  // Behavioral factors (computed, not from survey).
  if (behavior) {
    breakdown.push(...behaviorFactors(behavior, resolved));
  } else {
    // No history yet — give partial credit so first-time borrowers aren't
    // dinged into oblivion. 50% of behavioral-factor max keeps them in the
    // running while still leaving room to grow.
    for (const f of resolved.filter((x) => x.computed)) {
      breakdown.push({
        factorId: f.id,
        label: f.label,
        maxPoints: f.maxPoints,
        weight: 0.5,
        points: Math.round(f.maxPoints * 0.5),
        source: "No loan history yet — neutral score",
      });
    }
  }

  const rawScore = breakdown.reduce((s, b) => s + b.points, 0);
  // Linear scale to FICO-flavoured 300..850. The denominator is the
  // FIXED total, not a sum of whatever the catalog currently holds —
  // that pinning is what keeps the scale stable across catalog edits.
  const score = Math.round(300 + (rawScore / TOTAL_RAW_POINTS) * (850 - 300));
  const tier = toTier(score);
  const bucket = toBureauBucket(score);

  return {
    score,
    tier,
    bucket,
    rawScore,
    maxRaw: TOTAL_RAW_POINTS,
    breakdown,
  };
}

function evaluateQuestion(
  q: SurveyQuestion,
  answer: SurveyAnswer | undefined,
): { weight: number; source: string } {
  if (answer === undefined || answer === null || answer === "") {
    return { weight: 0, source: "No answer" };
  }
  switch (q.kind) {
    case "choice": {
      const opt = q.options.find((o) => o.value === String(answer));
      return {
        weight: opt?.weight ?? 0,
        source: opt ? opt.label : `Unrecognised value: ${String(answer)}`,
      };
    }
    case "number": {
      const n = typeof answer === "number" ? answer : Number(answer);
      if (!Number.isFinite(n)) return { weight: 0, source: "Invalid number" };
      const clamped = Math.max(q.min, Math.min(q.max, n));
      const rawWeight = (clamped - q.min) / (q.max - q.min || 1);
      const weight = q.inverted ? 1 - rawWeight : rawWeight;
      return {
        weight,
        source: q.inverted
          ? `${n} (lower is better; min=${q.min} max=${q.max})`
          : `${n} (higher is better; min=${q.min} max=${q.max})`,
      };
    }
    case "boolean": {
      const t = answer === true || answer === "true" || answer === 1;
      return {
        weight: t ? q.weightWhenTrue : 0,
        source: t ? "Yes" : "No",
      };
    }
  }
}

/**
 * On-time and default history, scored against the resolved catalog.
 *
 * Both factors are looked up by id and skipped when absent: an admin
 * who removes "default history" from the catalog gets a score without
 * it, rather than a crash on a non-null assertion.
 */
function behaviorFactors(
  b: BehaviorInput,
  resolved: ResolvedFactor[],
): FactorBreakdown[] {
  const onTime = resolved.find((f) => f.id === "on_time");
  const defaults = resolved.find((f) => f.id === "defaults");
  const out: FactorBreakdown[] = [];

  const onTimeWeight = b.onTimeRate ?? 0.5; // unknown → neutral
  const defaultPenalty = Math.min(1, b.defaults / Math.max(1, b.priorLoans));
  const defaultsWeight = 1 - defaultPenalty;

  if (onTime) {
    out.push({
      factorId: onTime.id,
      label: onTime.label,
      maxPoints: onTime.maxPoints,
      weight: onTimeWeight,
      points: Math.round(onTime.maxPoints * onTimeWeight),
      source:
        b.onTimeRate === null
          ? "No payments yet — neutral score"
          : `${Math.round(onTimeWeight * 100)}% on-time across ${b.priorLoans} prior loan(s)`,
    });
  }
  if (defaults) {
    out.push({
      factorId: defaults.id,
      label: defaults.label,
      maxPoints: defaults.maxPoints,
      weight: defaultsWeight,
      points: Math.round(defaults.maxPoints * defaultsWeight),
      source:
        b.defaults === 0
          ? "No defaults"
          : `${b.defaults} default(s) out of ${b.priorLoans}`,
    });
  }
  return out;
}
