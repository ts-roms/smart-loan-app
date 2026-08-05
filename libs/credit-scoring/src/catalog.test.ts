/**
 * Weight → points normalization.
 *
 * The invariant everything else rests on: whatever the admin does to
 * the catalog, the points sum to exactly TOTAL_RAW_POINTS. If that ever
 * drifts, every score shifts against a scale that's supposed to be
 * fixed, and decision-rule thresholds quietly change meaning.
 */

import { describe, expect, it } from "vitest";

import {
  resolveFactorPoints,
  TOTAL_RAW_POINTS,
  type CatalogFactor,
} from "./catalog";

const f = (id: string, weight: number): CatalogFactor => ({
  id,
  label: id,
  weight,
});

const total = (factors: CatalogFactor[]) =>
  resolveFactorPoints(factors).reduce((s, r) => s + r.maxPoints, 0);

describe("resolveFactorPoints", () => {
  it("reproduces the historical catalog exactly", () => {
    // The shipped weights ARE the old maxPoints, and they already sum
    // to 150 — so normalization must be a no-op on them. This is what
    // keeps pre-catalog scores comparable with post-catalog ones.
    const historical = [
      f("income", 25),
      f("employment", 20),
      f("debt", 20),
      f("housing", 10),
      f("dependents", 10),
      f("education", 5),
      f("savings", 10),
      f("on_time", 30),
      f("defaults", 20),
    ];
    const resolved = resolveFactorPoints(historical);
    expect(resolved.map((r) => r.maxPoints)).toEqual([
      25, 20, 20, 10, 10, 5, 10, 30, 20,
    ]);
    expect(total(historical)).toBe(TOTAL_RAW_POINTS);
  });

  it("sums to the total no matter how the weights are scaled", () => {
    // Only ratios matter — doubling every weight changes nothing.
    expect(total([f("a", 1), f("b", 1)])).toBe(TOTAL_RAW_POINTS);
    expect(total([f("a", 2), f("b", 2)])).toBe(TOTAL_RAW_POINTS);
    expect(total([f("a", 0.25), f("b", 0.25)])).toBe(TOTAL_RAW_POINTS);
    expect(
      resolveFactorPoints([f("a", 1), f("b", 1)]).map((r) => r.maxPoints),
    ).toEqual([75, 75]);
  });

  it("still sums exactly when the split doesn't divide cleanly", () => {
    // 150/7 is 21.43 — independent rounding would land on 147 or 154.
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((id) => f(id, 1));
    expect(total(seven)).toBe(TOTAL_RAW_POINTS);
    // Three factors get the leftover point, four don't.
    const points = resolveFactorPoints(seven)
      .map((r) => r.maxPoints)
      .sort();
    expect(points).toEqual([21, 21, 21, 21, 22, 22, 22]);
  });

  it("redistributes when a factor is added", () => {
    const before = resolveFactorPoints([f("a", 1), f("b", 1)]);
    const after = resolveFactorPoints([f("a", 1), f("b", 1), f("c", 1)]);
    // The existing factors give up points to make room — the scale
    // itself does not grow.
    expect(before[0]!.maxPoints).toBe(75);
    expect(after[0]!.maxPoints).toBe(50);
    expect(after.reduce((s, r) => s + r.maxPoints, 0)).toBe(TOTAL_RAW_POINTS);
  });

  it("redistributes when a factor is removed", () => {
    const after = resolveFactorPoints([f("a", 1), f("b", 1)]);
    expect(after.reduce((s, r) => s + r.maxPoints, 0)).toBe(TOTAL_RAW_POINTS);
    expect(after.map((r) => r.maxPoints)).toEqual([75, 75]);
  });

  it("ignores zero and negative weights rather than scoring them", () => {
    const resolved = resolveFactorPoints([f("a", 1), f("b", 0), f("c", -5)]);
    expect(resolved.map((r) => r.id)).toEqual(["a"]);
    expect(resolved[0]!.maxPoints).toBe(TOTAL_RAW_POINTS);
  });

  it("is deterministic — stored breakdowns must be reproducible", () => {
    const catalog = [f("a", 1), f("b", 1), f("c", 1), f("d", 1), f("e", 1)];
    const first = resolveFactorPoints(catalog);
    const second = resolveFactorPoints(catalog);
    expect(first).toEqual(second);
  });

  it("returns nothing for a degenerate catalog instead of dividing by zero", () => {
    expect(resolveFactorPoints([])).toEqual([]);
    expect(resolveFactorPoints([f("a", 0)])).toEqual([]);
  });
});
