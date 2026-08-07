import { describe, expect, it } from "vitest";

import { todayLocalISO } from "./index";

describe("todayLocalISO", () => {
  /**
   * The bug it exists for. `new Date().toISOString().slice(0, 10)` is
   * the UTC date; in Manila (UTC+8) that reads as YESTERDAY between
   * local midnight and 8am, so a report screen opened before breakfast
   * pre-filled the wrong day.
   */
  it("uses the local calendar date, not the UTC one", () => {
    // 07:00 local on the 8th is still the 7th in UTC.
    const earlyMorning = new Date(2026, 7, 8, 7, 0, 0);
    expect(todayLocalISO(earlyMorning)).toBe("2026-08-08");
  });

  it("agrees with the naive version once the two dates coincide", () => {
    const midday = new Date(2026, 7, 8, 12, 0, 0);
    expect(todayLocalISO(midday)).toBe("2026-08-08");
  });

  it("zero-pads month and day", () => {
    expect(todayLocalISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("rolls over at local midnight, not UTC midnight", () => {
    expect(todayLocalISO(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(todayLocalISO(new Date(2027, 0, 1, 0, 1))).toBe("2027-01-01");
  });
});
