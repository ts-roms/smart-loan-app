/**
 * Free-text search helpers.
 *
 * The behaviour worth pinning down is the AND-of-ORs shape, because it's
 * what makes the search usable and what's easiest to regress into a plain
 * `contains`:
 *
 *   • Every token must match somewhere → "juan cruz" finds Juan Dela Cruz
 *     but not every other Juan.
 *   • Order doesn't matter → "cruz juan" finds the same person.
 *   • No query means no clause at all, not a clause that matches nothing.
 */

import { describe, expect, it } from "vitest";

import { contains, searchTokens, tokenizedWhere } from "./search";

describe("searchTokens", () => {
  it("splits on whitespace and lower-cases", () => {
    expect(searchTokens("Dela Cruz")).toEqual(["dela", "cruz"]);
  });

  it("collapses runs of whitespace rather than emitting empty tokens", () => {
    expect(searchTokens("  juan   cruz  ")).toEqual(["juan", "cruz"]);
  });

  it("drops single characters — they match nearly every row", () => {
    expect(searchTokens("a juan")).toEqual(["juan"]);
  });

  it("de-duplicates so a repeated word isn't a repeated OR branch", () => {
    expect(searchTokens("cruz cruz")).toEqual(["cruz"]);
  });

  it("caps the token count so a pasted paragraph isn't a scan", () => {
    const many = "aa bb cc dd ee ff gg hh ii jj";
    expect(searchTokens(many)).toHaveLength(6);
  });

  it("treats empty, blank and missing queries as no search", () => {
    expect(searchTokens("")).toEqual([]);
    expect(searchTokens("   ")).toEqual([]);
    expect(searchTokens(undefined)).toEqual([]);
    expect(searchTokens(null)).toEqual([]);
  });
});

describe("tokenizedWhere", () => {
  const orsFor = (token: string) => [
    { firstName: contains(token) },
    { lastName: contains(token) },
  ];

  it("returns undefined for an empty query so the clause is omitted", () => {
    // Not `{ AND: [] }` and not a never-matching clause — an empty search
    // box has to mean "no filter", or the list goes blank on focus.
    expect(tokenizedWhere("", orsFor)).toBeUndefined();
    expect(tokenizedWhere(undefined, orsFor)).toBeUndefined();
  });

  it("requires every token to match at least one field", () => {
    const where = tokenizedWhere("juan cruz", orsFor);

    expect(where).toEqual({
      AND: [
        {
          OR: [{ firstName: contains("juan") }, { lastName: contains("juan") }],
        },
        {
          OR: [{ firstName: contains("cruz") }, { lastName: contains("cruz") }],
        },
      ],
    });
  });

  it("is order-independent — the same two tokens, the same two branches", () => {
    const forwards = tokenizedWhere("juan cruz", orsFor)!;
    const backwards = tokenizedWhere("cruz juan", orsFor)!;

    expect(backwards.AND).toHaveLength(forwards.AND.length);
    expect([...backwards.AND].reverse()).toEqual(forwards.AND);
  });
});

describe("contains", () => {
  it("always asks Postgres for a case-insensitive match", () => {
    // The whole reason this helper exists: `mode` is easy to forget at
    // one call site out of twenty, and the bug it causes ("search works
    // for Cruz but not cruz") is easy to miss in review.
    expect(contains("cruz")).toEqual({ contains: "cruz", mode: "insensitive" });
  });
});
