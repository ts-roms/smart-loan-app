/**
 * AML screening — the watchlist matcher.
 *
 * The status this returns drives a hard control: the decisioning engine
 * auto-rejects on `amlStatus = MATCH` and refuses to auto-approve anything
 * that isn't CLEAR or OVERRIDDEN. So the distinction between MATCH and
 * REVIEW is the distinction between "blocked" and "a human might catch it",
 * and the distinction between CLEAR and anything else is a claim that we
 * checked and found nothing.
 *
 * Two defects were found writing these and are fixed alongside:
 *
 *   1. An empty or whitespace-only name matched every row on the watchlist,
 *      because `c.includes("")` is true for every string.
 *   2. A watchlist row with stray whitespace — routine in imported
 *      third-party lists — never compared equal to an exact hit, so it
 *      scored 0.7 and downgraded MATCH to REVIEW. One padded row was enough
 *      to stop a sanctions hit from auto-rejecting.
 */

import { describe, expect, it } from "vitest";

import { MockAmlProvider, type ScreenResult } from "./index";

type Row = {
  list: string;
  fullName: string;
  aliases: string[];
  reason: string | null;
};

const OFAC: Row = {
  list: "OFAC",
  fullName: "Juan Dela Cruz",
  aliases: ["J. Dela Cruz", "Juanito Cruz"],
  reason: "Sanctions list",
};
const UN: Row = {
  list: "UN",
  fullName: "Maria Santos",
  aliases: [],
  reason: null,
};

const screenAgainst = (rows: Row[], fullName: string): Promise<ScreenResult> =>
  new MockAmlProvider(async () => rows).screen({ fullName });

describe("clean subjects", () => {
  it("returns CLEAR with no matches when nobody resembles the subject", async () => {
    const r = await screenAgainst([OFAC, UN], "Pedro Penduko");
    expect(r.status).toBe("CLEAR");
    expect(r.matches).toEqual([]);
  });

  it("returns CLEAR against an empty watchlist", async () => {
    const r = await screenAgainst([], "Juan Dela Cruz");
    expect(r.status).toBe("CLEAR");
  });
});

describe("exact hits produce MATCH (the auto-reject trigger)", () => {
  it("matches an exact full name, case-insensitively", async () => {
    for (const name of [
      "Juan Dela Cruz",
      "JUAN DELA CRUZ",
      "juan dela cruz",
      "  Juan Dela Cruz  ",
    ]) {
      const r = await screenAgainst([OFAC, UN], name);
      expect(r.status, `"${name}" should be an exact hit`).toBe("MATCH");
      expect(r.matches[0]?.score).toBe(1);
      expect(r.matches[0]?.list).toBe("OFAC");
    }
  });

  it("matches an exact alias just as hard as the primary name", async () => {
    const r = await screenAgainst([OFAC], "Juanito Cruz");
    expect(r.status).toBe("MATCH");
    expect(r.matches[0]?.score).toBe(1);
    // The officer needs the canonical listed name, not the alias they hit.
    expect(r.matches[0]?.matchedName).toBe("Juan Dela Cruz");
  });

  /**
   * Regression: watchlist rows are imported from third-party files and
   * routinely carry stray whitespace. Before the candidates were trimmed,
   * this scored 0.7 and came back REVIEW — and since the AML hard-block
   * only fires on MATCH, the sanctioned applicant was not auto-rejected.
   */
  it("still recognises an exact hit when the watchlist row is padded", async () => {
    const padded: Row = { ...OFAC, fullName: "  Juan Dela Cruz  " };
    const r = await screenAgainst([padded], "Juan Dela Cruz");
    expect(r.status).toBe("MATCH");
    expect(r.matches[0]?.score).toBe(1);
  });

  it("recognises a padded alias too", async () => {
    const padded: Row = { ...OFAC, aliases: ["  Juanito Cruz  "] };
    const r = await screenAgainst([padded], "Juanito Cruz");
    expect(r.status).toBe("MATCH");
  });

  it("carries the row's reason through for the officer", async () => {
    const r = await screenAgainst([OFAC], "Juan Dela Cruz");
    expect(r.matches[0]?.reason).toBe("Sanctions list");
  });

  it("omits the reason rather than inventing one when the row has none", async () => {
    const r = await screenAgainst([UN], "Maria Santos");
    expect(r.matches[0]?.reason).toBeUndefined();
  });
});

describe("partial hits produce REVIEW, not MATCH", () => {
  it("flags a subject whose name contains a listed name", async () => {
    const r = await screenAgainst([OFAC], "Mr Juan Dela Cruz Jr");
    expect(r.status).toBe("REVIEW");
    expect(r.matches[0]?.score).toBeLessThan(1);
  });

  it("flags a subject contained within a listed name", async () => {
    const r = await screenAgainst([OFAC], "Dela Cruz");
    expect(r.status).toBe("REVIEW");
  });

  it("never reports MATCH when every hit is partial", async () => {
    const r = await screenAgainst([OFAC, UN], "Santos");
    expect(r.status).toBe("REVIEW");
    expect(r.matches.every((m) => m.score < 1)).toBe(true);
  });

  it("prefers MATCH when one row is exact and another only partial", async () => {
    // An exact sanctions hit must not be diluted by a weaker hit elsewhere.
    const r = await screenAgainst([OFAC, UN], "Juan Dela Cruz");
    expect(r.status).toBe("MATCH");
  });
});

describe("unscreenable input", () => {
  /**
   * Regression: `c.includes("")` is true for every string, so an empty
   * subject used to match every row and hand back the whole watchlist as
   * hits. It must not report CLEAR either — that asserts a negative that was
   * never established.
   */
  it("does not match the entire watchlist on an empty name", async () => {
    for (const fullName of ["", "   ", "\t\n"]) {
      const r = await screenAgainst([OFAC, UN], fullName);
      expect(r.matches, `${JSON.stringify(fullName)} produced hits`).toEqual(
        [],
      );
      expect(r.status, `${JSON.stringify(fullName)} should not be CLEAR`).toBe(
        "REVIEW",
      );
    }
  });

  it("skips empty aliases instead of matching everyone against them", async () => {
    const sloppy: Row = { ...UN, aliases: ["", "   "] };
    const r = await screenAgainst([sloppy], "Pedro Penduko");
    expect(r.status).toBe("CLEAR");
  });
});

describe("result shape", () => {
  it("reports one hit per watchlist row, not one per alias", async () => {
    // "Juan Dela Cruz" matches the primary name and both aliases; the
    // officer should see the row once, not three times.
    const r = await screenAgainst([OFAC], "Juan Dela Cruz");
    expect(r.matches).toHaveLength(1);
  });

  it("returns every distinct row that hits", async () => {
    const similar: Row = {
      list: "INTERNAL",
      fullName: "Juan Dela Cruz",
      aliases: [],
      reason: "Internal watch",
    };
    const r = await screenAgainst([OFAC, similar], "Juan Dela Cruz");
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map((m) => m.list).sort()).toEqual(["INTERNAL", "OFAC"]);
  });

  it("always returns a known status", async () => {
    for (const name of ["Juan Dela Cruz", "Santos", "Nobody", ""]) {
      const r = await screenAgainst([OFAC, UN], name);
      expect(["PENDING", "CLEAR", "MATCH", "REVIEW"]).toContain(r.status);
    }
  });

  it("identifies itself as the MOCK provider", async () => {
    expect(new MockAmlProvider(async () => []).name).toBe("MOCK");
  });
});

describe("known limitation: substring matching is broad", () => {
  /**
   * Documented rather than fixed. Bidirectional substring matching means a
   * short alias flags unrelated people — "Al" hits "Ronald Reagan".
   *
   * A minimum-length guard would cut the false positives, but it would also
   * drop genuine short-name hits, and in AML a missed hit costs more than an
   * extra review. Real providers solve this with fuzzy scoring and
   * transliteration instead; this mock is a dev backstop. The test pins the
   * behaviour so the trade-off is a decision rather than a surprise.
   */
  it("flags unrelated names when a listed alias is very short", async () => {
    const short: Row = {
      list: "INTERNAL",
      fullName: "Al Capone",
      aliases: ["Al"],
      reason: null,
    };
    const r = await screenAgainst([short], "Ronald Reagan");
    expect(r.status).toBe("REVIEW");
    expect(r.matches[0]?.score).toBeLessThan(1);
  });
});
