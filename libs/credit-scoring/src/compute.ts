import {
  FACTORS,
  MAX_RAW_SCORE,
  SURVEY_QUESTIONS,
  type SurveyAnswer,
  type SurveyQuestion,
} from "./factors.js";
import {
  toBureauBucket,
  toTier,
  type BureauBucket,
  type Tier,
} from "./tier.js";

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
  /** Bureau-style 4-bucket label (FRD §3.9: Excellent/Good/Fair/Poor). */
  bucket: BureauBucket;
  /** Sum of every factor's points before scaling. */
  rawScore: number;
  /** Max possible raw score. */
  maxRaw: number;
  breakdown: FactorBreakdown[];
}

/**
 * Compute a credit score from survey answers + behavioral history.
 *
 * Survey-driven factors look up their weight from the question catalog;
 * behavioral factors (on-time payments, defaults) are derived directly
 * from `behavior`. Missing answers contribute 0 — they don't crash.
 */
export function computeCreditScore(input: {
  answers: Record<string, SurveyAnswer>;
  behavior?: BehaviorInput;
}): CreditScoreResult {
  const { answers, behavior } = input;
  const breakdown: FactorBreakdown[] = [];

  // Survey factors.
  for (const q of SURVEY_QUESTIONS) {
    const factor = FACTORS.find((f) => f.id === q.factorId);
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
    breakdown.push(...behaviorFactors(behavior));
  } else {
    // No history yet — give partial credit so first-time borrowers aren't
    // dinged into oblivion. 50% of behavioral-factor max keeps them in the
    // running while still leaving room to grow.
    for (const id of ["on_time", "defaults"]) {
      const f = FACTORS.find((x) => x.id === id);
      if (!f) continue;
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
  // Linear scale to FICO-flavoured 300..850.
  const score = Math.round(300 + (rawScore / MAX_RAW_SCORE) * (850 - 300));
  const tier = toTier(score);
  const bucket = toBureauBucket(score);

  return { score, tier, bucket, rawScore, maxRaw: MAX_RAW_SCORE, breakdown };
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

function behaviorFactors(b: BehaviorInput): FactorBreakdown[] {
  const onTime = FACTORS.find((f) => f.id === "on_time")!;
  const defaults = FACTORS.find((f) => f.id === "defaults")!;

  const onTimeWeight = b.onTimeRate ?? 0.5; // unknown → neutral
  const defaultPenalty = Math.min(1, b.defaults / Math.max(1, b.priorLoans));
  const defaultsWeight = 1 - defaultPenalty;

  return [
    {
      factorId: onTime.id,
      label: onTime.label,
      maxPoints: onTime.maxPoints,
      weight: onTimeWeight,
      points: Math.round(onTime.maxPoints * onTimeWeight),
      source:
        b.onTimeRate === null
          ? "No payments yet — neutral score"
          : `${Math.round(onTimeWeight * 100)}% on-time across ${b.priorLoans} prior loan(s)`,
    },
    {
      factorId: defaults.id,
      label: defaults.label,
      maxPoints: defaults.maxPoints,
      weight: defaultsWeight,
      points: Math.round(defaults.maxPoints * defaultsWeight),
      source:
        b.defaults === 0
          ? "No defaults"
          : `${b.defaults} default(s) out of ${b.priorLoans}`,
    },
  ];
}
