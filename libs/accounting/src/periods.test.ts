import { describe, expect, it } from "vitest";

import { endOfDay, startOfDay } from "./periods";

describe("day boundaries", () => {
  /**
   * The bug this exists for. `new Date("2026-08-07")` is UTC midnight —
   * the FIRST instant of the day — and in Manila that is 8am local, so
   * "as of the 7th" dropped every entry posted during the working day
   * of the 7th. ₱15,668.78 of them, on this repo's own fixtures.
   */
  it("reads a date-only asOf as the END of that day", () => {
    const d = endOfDay("2026-08-07");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August, 0-indexed
    expect(d.getDate()).toBe(7);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
    // The whole point: strictly after what the naive parse produced.
    expect(d.getTime()).toBeGreaterThan(new Date("2026-08-07").getTime());
  });

  it("reads a date-only from as the START of that day", () => {
    const d = startOfDay("2026-08-07");
    expect(d.getDate()).toBe(7);
    expect(d.getHours()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });

  /**
   * Only the ambiguous shape is widened. A caller who sends an instant
   * means that instant — widening it would quietly extend a report
   * past the cutoff they asked for.
   */
  it("leaves a full timestamp exactly as given", () => {
    const iso = "2026-08-07T09:30:00.000Z";
    expect(endOfDay(iso).toISOString()).toBe(iso);
    expect(startOfDay(iso).toISOString()).toBe(iso);
  });

  it("passes a Date through untouched", () => {
    const d = new Date("2026-08-07T09:30:00.000Z");
    expect(endOfDay(d)).toBe(d);
    expect(startOfDay(d)).toBe(d);
  });

  it("brackets the day so start < end", () => {
    expect(startOfDay("2026-08-07").getTime()).toBeLessThan(
      endOfDay("2026-08-07").getTime(),
    );
  });

  it("does not leak into the next day", () => {
    // 23:59:59.999 rather than the next midnight: every caller compares
    // with `lte`, and an exclusive bound would include the next day's
    // first millisecond through all of them.
    expect(endOfDay("2026-08-07").getTime()).toBeLessThan(
      startOfDay("2026-08-08").getTime(),
    );
  });

  it("handles month and year ends", () => {
    expect(endOfDay("2026-12-31").getDate()).toBe(31);
    expect(endOfDay("2026-12-31").getMonth()).toBe(11);
    expect(startOfDay("2026-03-01").getMonth()).toBe(2);
  });
});
