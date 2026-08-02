/**
 * Credit scoring — the number that decides a borrower's tier, and through
 * per-tier pricing, the rate they're offered. It had no tests.
 *
 * The approach here is deliberately property-based rather than
 * example-based. A handful of hand-picked cases would pass happily while
 * the scale drifted out of range or a tier boundary opened a gap; the
 * amortization bug earlier in this repo survived exactly that way, behind
 * a `toBeCloseTo(principal, 1)` that tolerated ±0.05.
 *
 * Best/worst answers are derived from SURVEY_QUESTIONS at runtime instead
 * of being hardcoded, so adding or reweighting a question doesn't quietly
 * turn these assertions into checks of a stale catalog.
 */

import { describe, expect, it } from "vitest";

import { computeCreditScore, type BehaviorInput } from "./compute";
import {
  FACTORS,
  MAX_RAW_SCORE,
  SURVEY_QUESTIONS,
  type SurveyAnswer,
} from "./factors";
import { toTier } from "./tier";

// ─── Answer builders, derived from the live question catalog ───────────

function bestAnswer(q: (typeof SURVEY_QUESTIONS)[number]): SurveyAnswer {
  switch (q.kind) {
    case "number":
      return q.inverted ? q.min : q.max;
    case "boolean":
      return true;
    case "choice":
      return [...q.options].sort((a, b) => b.weight - a.weight)[0]!.value;
  }
}

function worstAnswer(q: (typeof SURVEY_QUESTIONS)[number]): SurveyAnswer {
  switch (q.kind) {
    case "number":
      return q.inverted ? q.max : q.min;
    case "boolean":
      return false;
    case "choice":
      return [...q.options].sort((a, b) => a.weight - b.weight)[0]!.value;
  }
}

const BEST = Object.fromEntries(
  SURVEY_QUESTIONS.map((q) => [q.id, bestAnswer(q)]),
);
const WORST = Object.fromEntries(
  SURVEY_QUESTIONS.map((q) => [q.id, worstAnswer(q)]),
);

const PERFECT_BEHAVIOR: BehaviorInput = {
  priorLoans: 5,
  defaults: 0,
  onTimeRate: 1,
};
const TERRIBLE_BEHAVIOR: BehaviorInput = {
  priorLoans: 5,
  defaults: 5,
  onTimeRate: 0,
};

describe("computeCreditScore — range", () => {
  it("never leaves the 300–850 band, across the whole answer space", () => {
    const behaviors: Array<BehaviorInput | undefined> = [
      undefined,
      PERFECT_BEHAVIOR,
      TERRIBLE_BEHAVIOR,
      { priorLoans: 0, defaults: 0, onTimeRate: null },
      // Data anomalies the repository shouldn't produce but might:
      // more defaults than loans, and no prior loans with defaults.
      { priorLoans: 1, defaults: 9, onTimeRate: 0.5 },
      { priorLoans: 0, defaults: 3, onTimeRate: null },
    ];
    const answerSets = [BEST, WORST, {}, { monthly_income: 50_000 }];

    for (const answers of answerSets) {
      for (const behavior of behaviors) {
        const r = computeCreditScore({ answers, behavior });
        const where = `answers=${JSON.stringify(answers).slice(0, 40)} behavior=${JSON.stringify(behavior)}`;
        expect(r.score, `min — ${where}`).toBeGreaterThanOrEqual(300);
        expect(r.score, `max — ${where}`).toBeLessThanOrEqual(850);
        expect(Number.isInteger(r.score), `integer — ${where}`).toBe(true);
      }
    }
  });

  it("reaches exactly 850 when every factor is maxed", () => {
    const r = computeCreditScore({
      answers: BEST,
      behavior: PERFECT_BEHAVIOR,
    });
    // If this drifts below 850, a factor is unreachable — usually a FACTORS
    // entry with no survey question feeding it, which silently caps the
    // best attainable score.
    expect(r.rawScore).toBe(MAX_RAW_SCORE);
    expect(r.score).toBe(850);
    expect(r.tier).toBe("A");
  });

  /**
   * The floor is deliberately above zero. Several choice questions have no
   * "absent" option — housing bottoms out at "renting" (weight 0.5) and
   * education at "elementary" (0.3), because renting is not the absence of
   * housing and elementary is not the absence of schooling. So the worst
   * possible applicant still scores above 300.
   *
   * Deriving the expected floor from the catalog rather than hardcoding it
   * means reweighting a question updates this test's expectation with it,
   * while still catching a factor that starts paying out unexpectedly.
   */
  it("bottoms out at the catalog's minimum, and lands in tier F", () => {
    const minSurveyRaw = SURVEY_QUESTIONS.reduce((sum, q) => {
      const factor = FACTORS.find((f) => f.id === q.factorId);
      if (!factor) return sum;
      const minWeight =
        q.kind === "choice" ? Math.min(...q.options.map((o) => o.weight)) : 0;
      return sum + Math.round(factor.maxPoints * minWeight);
    }, 0);

    const r = computeCreditScore({
      answers: WORST,
      behavior: TERRIBLE_BEHAVIOR,
    });

    expect(r.rawScore).toBe(minSurveyRaw);
    expect(r.tier).toBe("F");
    expect(r.score).toBeGreaterThanOrEqual(300);
  });

  it("no input scores below the worst-case applicant", () => {
    const floor = computeCreditScore({
      answers: WORST,
      behavior: TERRIBLE_BEHAVIOR,
    }).score;
    const probes: Array<Record<string, SurveyAnswer>> = [
      {},
      BEST,
      WORST,
      { monthly_income: -999_999 },
      { dependents: 9_999 },
    ];
    for (const answers of probes) {
      for (const behavior of [undefined, TERRIBLE_BEHAVIOR, PERFECT_BEHAVIOR]) {
        const r = computeCreditScore({ answers, behavior });
        expect(
          r.score,
          `scored below the documented floor: ${JSON.stringify(answers).slice(0, 40)}`,
        ).toBeGreaterThanOrEqual(Math.min(floor, 300));
      }
    }
  });

  it("every factor is represented in the breakdown exactly once", () => {
    const r = computeCreditScore({ answers: BEST, behavior: PERFECT_BEHAVIOR });
    const ids = r.breakdown.map((b) => b.factorId).sort();
    const expected = FACTORS.map((f) => f.id).sort();
    // A duplicate would let one factor be counted twice and push rawScore
    // past MAX_RAW_SCORE; a missing one caps the attainable maximum.
    expect(ids).toEqual(expected);
  });
});

describe("computeCreditScore — monotonicity", () => {
  it("improving any single answer never lowers the score", () => {
    const base = computeCreditScore({ answers: WORST, behavior: undefined });
    for (const q of SURVEY_QUESTIONS) {
      const improved = computeCreditScore({
        answers: { ...WORST, [q.id]: bestAnswer(q) },
        behavior: undefined,
      });
      expect(
        improved.score,
        `improving ${q.id} lowered the score (${base.score} -> ${improved.score})`,
      ).toBeGreaterThanOrEqual(base.score);
    }
  });

  it("more defaults never raises the score", () => {
    let previous = Infinity;
    for (const defaults of [0, 1, 2, 3, 4, 5]) {
      const r = computeCreditScore({
        answers: BEST,
        behavior: { priorLoans: 5, defaults, onTimeRate: 1 },
      });
      expect(
        r.score,
        `${defaults} defaults scored higher than ${defaults - 1}`,
      ).toBeLessThanOrEqual(previous);
      previous = r.score;
    }
  });

  it("a higher on-time rate never lowers the score", () => {
    let previous = -Infinity;
    for (const onTimeRate of [0, 0.25, 0.5, 0.75, 1]) {
      const r = computeCreditScore({
        answers: BEST,
        behavior: { priorLoans: 5, defaults: 0, onTimeRate },
      });
      expect(
        r.score,
        `onTimeRate ${onTimeRate} regressed`,
      ).toBeGreaterThanOrEqual(previous);
      previous = r.score;
    }
  });
});

describe("computeCreditScore — missing and malformed input", () => {
  it("scores an empty survey without throwing, contributing zero", () => {
    const r = computeCreditScore({ answers: {} });
    const surveyPoints = r.breakdown
      .filter((b) => !["on_time", "defaults"].includes(b.factorId))
      .reduce((s, b) => s + b.points, 0);
    expect(surveyPoints).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(300);
  });

  it("treats an unrecognised choice value as zero rather than crashing", () => {
    const choice = SURVEY_QUESTIONS.find((q) => q.kind === "choice");
    if (!choice) return;
    const r = computeCreditScore({
      answers: { ...WORST, [choice.id]: "not-a-real-option" },
    });
    const row = r.breakdown.find((b) => b.factorId === choice.factorId);
    expect(row?.points).toBe(0);
    expect(row?.source).toMatch(/Unrecognised/i);
  });

  it("clamps out-of-range numeric answers instead of extrapolating", () => {
    const num = SURVEY_QUESTIONS.find((q) => q.kind === "number");
    if (!num || num.kind !== "number") return;
    const beyondMax = computeCreditScore({
      answers: { ...BEST, [num.id]: num.max * 100 },
    });
    const atMax = computeCreditScore({
      answers: { ...BEST, [num.id]: num.max },
    });
    // Without the clamp, a wildly large income would inflate the weight past
    // 1 and carry the whole score above 850.
    expect(beyondMax.score).toBe(atMax.score);
    expect(beyondMax.score).toBeLessThanOrEqual(850);
  });
});

describe("computeCreditScore — first-time borrowers", () => {
  it("gives neutral credit for behaviour rather than zero", () => {
    const noHistory = computeCreditScore({ answers: BEST });
    const badHistory = computeCreditScore({
      answers: BEST,
      behavior: TERRIBLE_BEHAVIOR,
    });
    const goodHistory = computeCreditScore({
      answers: BEST,
      behavior: PERFECT_BEHAVIOR,
    });

    // A first-time borrower should sit strictly between someone who has
    // defaulted on everything and someone with a spotless record —
    // otherwise "no history" is indistinguishable from "bad history".
    expect(noHistory.score).toBeGreaterThan(badHistory.score);
    expect(noHistory.score).toBeLessThan(goodHistory.score);

    for (const id of ["on_time", "defaults"]) {
      const row = noHistory.breakdown.find((b) => b.factorId === id);
      expect(row?.weight, `${id} should be neutral`).toBe(0.5);
    }
  });
});

describe("toTier", () => {
  it("maps the documented boundaries exactly", () => {
    expect(toTier(850)).toBe("A");
    expect(toTier(750)).toBe("A");
    expect(toTier(749)).toBe("B");
    expect(toTier(700)).toBe("B");
    expect(toTier(699)).toBe("C");
    expect(toTier(600)).toBe("C");
    expect(toTier(599)).toBe("D");
    expect(toTier(500)).toBe("D");
    expect(toTier(499)).toBe("F");
    expect(toTier(300)).toBe("F");
  });

  it("covers every score in the band with no gaps, and never improves as the score falls", () => {
    const rank = { F: 0, D: 1, C: 2, B: 3, A: 4 } as const;
    let previous = rank[toTier(300)];
    for (let score = 300; score <= 850; score++) {
      const tier = toTier(score);
      expect(rank[tier], `no tier for ${score}`).toBeDefined();
      expect(
        rank[tier],
        `tier went backwards at ${score} (${tier})`,
      ).toBeGreaterThanOrEqual(previous);
      previous = rank[tier];
    }
  });
});
