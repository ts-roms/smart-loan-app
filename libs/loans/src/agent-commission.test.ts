import { describe, expect, it } from "vitest";

import {
  agentBookTotals,
  assertValidCommissionRate,
  InvalidCommissionRateError,
  MAX_COMMISSION_RATE,
  quoteCommission,
  type AgentBookRow,
} from "./agent-commission";

describe("quoteCommission", () => {
  it("uses the product's rate when the agent has no override", () => {
    const q = quoteCommission({ principal: 50_000, productRate: 0.02 });
    expect(q).toEqual({ rate: 0.02, amount: 1_000, source: "PRODUCT_DEFAULT" });
  });

  it("prefers the agent's override when they have one", () => {
    const q = quoteCommission({
      principal: 50_000,
      agentRate: 0.035,
      productRate: 0.02,
    });
    expect(q).toEqual({ rate: 0.035, amount: 1_750, source: "AGENT_OVERRIDE" });
  });

  /**
   * The reason the resolution uses `??` and not `||`. An agent set to
   * zero earns nothing — that is the single most important thing an
   * override can say — and `||` would fall straight through to the
   * product's rate and pay them anyway.
   */
  it("treats an override of zero as an override, not as absent", () => {
    const q = quoteCommission({
      principal: 50_000,
      agentRate: 0,
      productRate: 0.02,
    });
    expect(q).toEqual({ rate: 0, amount: 0, source: "AGENT_OVERRIDE" });
  });

  it("tells null and undefined apart from zero", () => {
    for (const agentRate of [null, undefined]) {
      const q = quoteCommission({
        principal: 10_000,
        agentRate,
        productRate: 0.01,
      });
      expect(q.source).toBe("PRODUCT_DEFAULT");
      expect(q.amount).toBe(100);
    }
  });

  it("pays nothing on a product nobody configured", () => {
    // The product rate defaults to 0 in the schema on purpose: adding an
    // agent to a loan under an unconfigured product must pay nothing,
    // not some made-up house rate.
    const q = quoteCommission({ principal: 250_000, productRate: 0 });
    expect(q.amount).toBe(0);
  });

  it("rounds to centavos", () => {
    // 33,333.33 × 1.5% = 499.99995
    const q = quoteCommission({ principal: 33_333.33, productRate: 0.015 });
    expect(q.amount).toBe(500);
  });

  /**
   * The guard that matters. A rate is a FRACTION; someone typing "2"
   * meaning 2% would book ₱100,000 of commission on a ₱50,000 loan that
   * has not earned a peso. Rejected rather than clamped — it is a typo,
   * and silently charging 50% instead of 200% is not a fix.
   */
  it("refuses a percentage entered where a fraction was expected", () => {
    expect(() =>
      quoteCommission({ principal: 50_000, productRate: 2 }),
    ).toThrow(InvalidCommissionRateError);
    expect(() =>
      quoteCommission({ principal: 50_000, agentRate: 5, productRate: 0.02 }),
    ).toThrow(InvalidCommissionRateError);
  });

  it("validates the losing rate too", () => {
    // A bad override must be reported when it is set, not lie dormant
    // until the day the product's rate is removed and it goes live.
    expect(() =>
      quoteCommission({ principal: 1_000, agentRate: 0.01, productRate: 99 }),
    ).toThrow(InvalidCommissionRateError);
  });

  it("refuses a negative rate and accepts the ceiling exactly", () => {
    expect(() => assertValidCommissionRate(-0.01)).toThrow();
    expect(() => assertValidCommissionRate(Number.NaN)).toThrow();
    expect(() => assertValidCommissionRate(MAX_COMMISSION_RATE)).not.toThrow();
    expect(() =>
      assertValidCommissionRate(MAX_COMMISSION_RATE + 0.0001),
    ).toThrow();
  });

  it("names the offending rate in the error", () => {
    // The officer who typed it needs to see what they typed.
    try {
      assertValidCommissionRate(2);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("2");
      expect((e as Error).message).toContain("fraction");
    }
  });
});

describe("agentBookTotals", () => {
  const row = (
    status: string,
    commissionAmount: number | null,
  ): AgentBookRow => ({
    status,
    commissionAmount,
  });

  it("counts commission as earned only once the loan is funded", () => {
    const totals = agentBookTotals([
      row("ACTIVE", 1_000),
      row("CLOSED", 500),
      // Approved is not funded. Paying on approval would make an agent's
      // earnings FALL when a loan they were credited for fell over
      // before release.
      row("APPROVED", 750),
      row("SUBMITTED", 250),
    ]);
    expect(totals).toEqual({
      loanCount: 4,
      fundedCount: 2,
      earned: 1_500,
      pipeline: 1_000,
    });
  });

  /**
   * The commission was paid in cash when the money went out, and this
   * product does not claw it back. Dropping these rows would make an
   * agent's total fall retroactively and disagree with the ledger.
   */
  it("keeps commission on a loan that later defaulted", () => {
    const totals = agentBookTotals([
      row("DEFAULTED", 2_000),
      row("WRITTEN_OFF", 1_000),
    ]);
    expect(totals.earned).toBe(3_000);
    expect(totals.fundedCount).toBe(2);
  });

  it("counts a restructured loan as earned", () => {
    // You can only restructure a funded loan, so the money went out.
    expect(agentBookTotals([row("RESTRUCTURED", 800)]).earned).toBe(800);
  });

  it("leaves rejected and cancelled applications out of the pipeline", () => {
    // A pipeline figure that includes dead applications can only ever
    // fall, which makes it worse than useless to the person reading it.
    const totals = agentBookTotals([
      row("REJECTED", 5_000),
      row("CANCELLED", 5_000),
      row("SUBMITTED", 400),
    ]);
    expect(totals.pipeline).toBe(400);
    expect(totals.earned).toBe(0);
    // Still their loans, and still counted as such.
    expect(totals.loanCount).toBe(3);
  });

  it("treats a loan with no frozen commission as zero", () => {
    // Assigned before the product had a rate, or assigned at 0.
    const totals = agentBookTotals([row("ACTIVE", null), row("ACTIVE", 100)]);
    expect(totals.earned).toBe(100);
    expect(totals.fundedCount).toBe(2);
  });

  it("returns zeroes for an agent with no book yet", () => {
    expect(agentBookTotals([])).toEqual({
      loanCount: 0,
      fundedCount: 0,
      earned: 0,
      pipeline: 0,
    });
  });

  it("rounds the totals rather than the rows", () => {
    const totals = agentBookTotals([
      row("ACTIVE", 0.1),
      row("ACTIVE", 0.2),
      row("ACTIVE", 0.3),
    ]);
    expect(totals.earned).toBe(0.6);
  });
});
