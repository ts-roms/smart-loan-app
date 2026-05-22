import { describe, expect, it } from "vitest";

import {
  AGGREGATE_CAP_RATE,
  INDIVIDUAL_CAP_RATE,
  computeCaps,
  scoreNameMatch,
  tokenize,
} from "./dorsi-helpers";

/**
 * Unit tests for the pure DORSI helpers (FRD §3.10).
 *
 * These functions are the only piece of the DORSI feature that can run
 * without Prisma — the rest of the repository is integration-test
 * territory. They cover:
 *   • Cap math — the 15% / 30% rates and rounding rules
 *   • Name tokenisation — diacritics, punctuation, single-letter drop
 *   • Match scoring — exact / subset / family-name tiers
 */

describe("computeCaps", () => {
  it("computes 15% aggregate / 30%-of-aggregate individual at the canonical rates", () => {
    const c = computeCaps(100_000_000);
    expect(c.aggregateCap).toBe(15_000_000); // 100M × 15%
    expect(c.individualCap).toBe(4_500_000); // 15M × 30%
  });

  it("returns zeros for zero equity (no DORSI loans allowed)", () => {
    const c = computeCaps(0);
    expect(c.aggregateCap).toBe(0);
    expect(c.individualCap).toBe(0);
  });

  it("clamps negative equity to zero (defensive — admin input mistake)", () => {
    const c = computeCaps(-1_000_000);
    expect(c.aggregateCap).toBe(0);
    expect(c.individualCap).toBe(0);
  });

  it("rounds to two decimals", () => {
    // 33_333.33 × 0.15 = 4999.9995 → 5000.00 rounded
    const c = computeCaps(33_333.33);
    expect(c.aggregateCap).toBeCloseTo(5_000, 2);
  });

  it("keeps the canonical rate constants visible (locked at 0.15 + 0.3)", () => {
    expect(AGGREGATE_CAP_RATE).toBe(0.15);
    expect(INDIVIDUAL_CAP_RATE).toBe(0.3);
  });
});

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenize("Juan Dela Cruz")).toEqual(["juan", "dela", "cruz"]);
  });

  it("strips punctuation and collapses extra whitespace", () => {
    expect(tokenize("Maria,  Reyes-Santos")).toEqual([
      "maria",
      "reyes",
      "santos",
    ]);
  });

  it("strips diacritics (NFD + combining marks)", () => {
    expect(tokenize("José Peñalosa")).toEqual(["jose", "penalosa"]);
  });

  it("drops single-letter tokens (avoids spurious middle-initial matches)", () => {
    // "J" middle initial would otherwise create a 1-character false-match
    // hit when scoring against records lacking middle names.
    expect(tokenize("Juan J Dela Cruz")).toEqual(["juan", "dela", "cruz"]);
  });

  it("returns an empty array for an empty / whitespace string", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("scoreNameMatch", () => {
  it("returns similarity 1.0 + 'Exact name match' for an identical token sequence", () => {
    const r = scoreNameMatch(
      ["juan", "dela", "cruz"],
      ["juan", "dela", "cruz"],
    );
    expect(r.similarity).toBe(1.0);
    expect(r.reason).toBe("Exact name match");
  });

  it("returns similarity 0.85 when the candidate is a subset of the record", () => {
    // Candidate has 2 tokens, record has 3; both candidate tokens are
    // present in the record → subset match.
    const r = scoreNameMatch(["juan", "cruz"], ["juan", "dela", "cruz"]);
    expect(r.similarity).toBe(0.85);
    expect(r.reason).toMatch(/Token subset/);
  });

  it("returns similarity 0.85 when the record is a subset of the candidate", () => {
    // Mirror of the above — the smaller side gets fully matched.
    const r = scoreNameMatch(["juan", "dela", "cruz"], ["juan", "cruz"]);
    expect(r.similarity).toBe(0.85);
  });

  it("falls through to 0.5 family-name match when only the surname agrees", () => {
    const r = scoreNameMatch(
      ["maria", "santos", "cruz"],
      ["juan", "cruz"], // 'cruz' is the last token on both
    );
    expect(r.similarity).toBe(0.5);
    expect(r.reason).toMatch(/Family-name match/);
  });

  it("rejects family-name matches when the surname is < 3 chars", () => {
    // 2-letter surnames are too short to be useful (e.g. 'Ng', 'Co').
    // Treat them as non-matches rather than fire low-quality alerts.
    const r = scoreNameMatch(["juan", "ng"], ["maria", "ng"]);
    expect(r.similarity).toBe(0);
  });

  it("returns 0 when there's no overlap at all", () => {
    const r = scoreNameMatch(["alice", "smith"], ["bob", "jones"]);
    expect(r.similarity).toBe(0);
    expect(r.reason).toBeNull();
  });

  it("returns 0 for empty inputs", () => {
    expect(scoreNameMatch([], ["juan"])).toEqual({
      similarity: 0,
      reason: null,
    });
    expect(scoreNameMatch(["juan"], [])).toEqual({
      similarity: 0,
      reason: null,
    });
  });

  it("requires at least 2 overlapping tokens for the subset tier (single-name hits go to family-name)", () => {
    // Single common token doesn't qualify as 'subset' (cSet.size = 1,
    // intersect = 1, but we require intersect ≥ 2). Falls through to
    // family-name if the last tokens match; otherwise 0.
    const r = scoreNameMatch(["juan"], ["juan", "dela", "cruz"]);
    // Last tokens differ ('juan' vs 'cruz') so this returns 0.
    expect(r.similarity).toBe(0);
  });
});
