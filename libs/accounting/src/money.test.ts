import { describe, expect, it } from "vitest";

import {
  addMoney,
  centavosToDecimalString,
  fromCentavos,
  isAtLeast,
  toCentavos,
} from "./money";

/**
 * The centavo arithmetic the allocator runs on (§11).
 *
 * The property that matters most is the round trip: a value that came off a
 * `Decimal(14, 2)` column must come back as the same two decimals, without
 * ever having been a double in between.
 */

describe("toCentavos", () => {
  it("parses the decimal text a NUMERIC(14,2) column produces", () => {
    expect(toCentavos("8026.26")).toBe(802_626);
    expect(toCentavos("750.00")).toBe(75_000);
    expect(toCentavos("0.01")).toBe(1);
    expect(toCentavos("0.00")).toBe(0);
    expect(toCentavos("52657.57")).toBe(5_265_757);
  });

  it("accepts JS numbers, decimal strings and Decimal-likes alike", () => {
    // A `Prisma.Decimal` is accepted structurally, via toString — which is
    // what keeps this package free of a Prisma dependency.
    const decimalLike = { toString: () => "8026.26" };
    expect(toCentavos(8026.26)).toBe(802_626);
    expect(toCentavos("8026.26")).toBe(802_626);
    expect(toCentavos(decimalLike)).toBe(802_626);
  });

  it("handles values with no fraction, and bare fractions", () => {
    expect(toCentavos("50000")).toBe(5_000_000);
    expect(toCentavos(".5")).toBe(50);
    expect(toCentavos("7.")).toBe(700);
  });

  it("carries the sign", () => {
    expect(toCentavos("-129.70")).toBe(-12_970);
    expect(toCentavos("+129.70")).toBe(12_970);
  });

  it("does not construct the float, so binary error never reaches it", () => {
    /*
     * The point of parsing text rather than multiplying by 100. As a
     * double, 1.005 is 1.00499999999999989…, so `Math.round(1.005 * 100)`
     * is 100 — a centavo lost to a representation the value never had. The
     * decimal 1.005 rounds to 1.01, and that is what a ledger means by it.
     */
    expect(toCentavos("1.005")).toBe(101);
    expect(Math.round(1.005 * 100)).toBe(100);

    // Not every half-centavo case diverges — 2.675 happens to sit just
    // above its decimal value as a double, so both routes reach 268. The
    // point is that the text route is right by construction rather than by
    // which side of the value the binary approximation happened to fall.
    expect(toCentavos("2.675")).toBe(268);
  });

  it("rounds a third decimal half away from zero", () => {
    expect(toCentavos("0.004")).toBe(0);
    expect(toCentavos("0.005")).toBe(1);
    expect(toCentavos("0.006")).toBe(1);
    expect(toCentavos("-0.005")).toBe(-1);
  });

  it("reads exponent notation rather than mis-parsing it", () => {
    // `String()` reaches for exponents at the extremes, and reading "1e-7"
    // as 1 would be a peso invented out of nothing.
    expect(toCentavos("1e-7")).toBe(0);
    expect(toCentavos("1.5e3")).toBe(150_000);
    expect(toCentavos("-2.5e2")).toBe(-25_000);
    expect(toCentavos(1e-7)).toBe(0);
  });

  it("refuses values that are not decimal money", () => {
    expect(() => toCentavos("")).toThrow(TypeError);
    expect(() => toCentavos("abc")).toThrow(TypeError);
    expect(() => toCentavos("1,000.00")).toThrow(TypeError);
    expect(() => toCentavos(Number.NaN)).toThrow();
  });

  it("refuses a magnitude that would stop being an exact integer", () => {
    // Better to fail loudly than to silently drop a centavo.
    expect(() => toCentavos("1e18")).toThrow(RangeError);
  });

  it("spans the whole Decimal(14,2) domain", () => {
    // The largest value the column can hold.
    expect(toCentavos("999999999999.99")).toBe(99_999_999_999_999);
    expect(Number.isSafeInteger(toCentavos("999999999999.99"))).toBe(true);
  });
});

describe("fromCentavos", () => {
  it("lands on the same double `round2` produced", () => {
    // Both end in a division by 100, so the bit patterns are identical —
    // which is why the allocation golden tests pass across the rewrite.
    for (const pesos of [750.0, 8026.26, 629.61, 129.7, 52_657.57, 0.01]) {
      const viaRound2 = Math.round(pesos * 100) / 100;
      expect(fromCentavos(toCentavos(String(pesos)))).toBe(viaRound2);
    }
  });

  it("round-trips every value a 2-decimal column can hold", () => {
    for (const text of ["0.00", "0.01", "129.70", "8026.26", "999999.99"]) {
      expect(fromCentavos(toCentavos(text))).toBe(Number(text));
    }
  });
});

describe("centavosToDecimalString", () => {
  it("writes exact 2-decimal text without going through a double", () => {
    expect(centavosToDecimalString(802_626)).toBe("8026.26");
    expect(centavosToDecimalString(75_000)).toBe("750.00");
    expect(centavosToDecimalString(1)).toBe("0.01");
    expect(centavosToDecimalString(0)).toBe("0.00");
    expect(centavosToDecimalString(100)).toBe("1.00");
    expect(centavosToDecimalString(-12_970)).toBe("-129.70");
  });

  it("pads the centavo field so 5 is never written as .5", () => {
    expect(centavosToDecimalString(5)).toBe("0.05");
    expect(centavosToDecimalString(1_005)).toBe("10.05");
  });
});

describe("addMoney", () => {
  it("sums exactly where floats would drift", () => {
    // The classic: 0.1 + 0.2 !== 0.3 as doubles.
    expect(addMoney("0.10", "0.20")).toBe("0.30");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("adds a stored Decimal to an allocation slice", () => {
    // Exactly the shape `recordPayment` uses: the column, plus the number
    // the allocator handed back.
    expect(addMoney({ toString: () => "2250.00" }, 5776.26)).toBe("8026.26");
    expect(addMoney({ toString: () => "0.00" }, 750)).toBe("750.00");
  });

  it("accumulates a whole schedule without losing a centavo", () => {
    const interest = [
      "750.00",
      "629.61",
      "507.41",
      "383.37",
      "257.48",
      "129.70",
    ];
    expect(addMoney(...interest)).toBe("2657.57");
  });

  it("returns text a Decimal column takes verbatim", () => {
    expect(addMoney("8026.25", "0.01")).toBe("8026.26");
  });
});

describe("isAtLeast — the settlement test", () => {
  it("settles on the exact figure", () => {
    expect(isAtLeast("8026.26", "8026.26")).toBe(true);
    expect(isAtLeast("750.00", "750.00")).toBe(true);
  });

  it("does not settle a centavo short", () => {
    // The figure the golden tests pin: 8,776.25 against an 8,776.26
    // instalment leaves the row open.
    expect(isAtLeast("8026.25", "8026.26")).toBe(false);
  });

  it("settles when more than enough has been collected", () => {
    expect(isAtLeast("8026.27", "8026.26")).toBe(true);
  });

  it("reproduces the old half-centavo tolerance exactly on 2-decimal data", () => {
    /*
     * The tolerance it replaces was `paid + 0.005 >= due`. Across every
     * value a Decimal(14,2) column can hold, the two agree — which is what
     * makes dropping it a no-op rather than a change of policy.
     */
    for (let due = 0; due <= 2_000; due++) {
      for (const delta of [-2, -1, 0, 1, 2]) {
        const paid = due + delta;
        const old = paid / 100 + 0.005 >= due / 100;
        expect(
          isAtLeast(
            centavosToDecimalString(paid),
            centavosToDecimalString(due),
          ),
        ).toBe(old);
      }
    }
  });

  it("compares a stored Decimal against allocation output", () => {
    expect(isAtLeast({ toString: () => "8026.26" }, 8026.26)).toBe(true);
    expect(isAtLeast({ toString: () => "8026.25" }, 8026.26)).toBe(false);
  });
});
