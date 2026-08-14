import { describe, expect, it } from "vitest";

import {
  evaluateRules,
  type DecisionRule,
  type DecisioningContext,
} from "./index";

/**
 * Invariant: whatever the engine decides, the decision can name the
 * exact text of the rule that made it.
 *
 * `decisionReason` was prose — "A-tier fast-track" — and prose names a
 * rule without preserving it. Rules are in a table so they can be
 * retuned, so the row called "A-tier fast-track" a year from now may
 * demand a score this borrower never had. The version is the difference
 * between a decision that is explainable and one that merely looks it.
 *
 * These tests are on the engine because that is where the fact
 * originates: if the matched rule does not carry its version out, no
 * amount of care downstream can put it back.
 */

const ctx: DecisioningContext = {
  productCode: "SALARY",
  principal: 50_000,
  termMonths: 12,
  annualInterestRate: 0.18,
  tierAtApply: "B",
  creditScoreAtApply: 690,
  amlStatus: "CLEAR",
  kycComplete: true,
  customerAge: 34,
  monthlyIncome: 40_000,
  existingActiveLoans: 0,
  // No other loans. Provenance is about the rule that fired, not about
  // exposure — these are here so the fixture type-checks, and nothing
  // in this file asserts on them.
  existingExposure: 0,
  existingExposureOutstanding: 0,
  existingPastDue: 0,
  existingExposureLoans: 0,
  existingWrittenOff: 0,
  totalExposureAfterLoan: 50_000,
  existingMonthlyObligations: 0,
  newLoanInstallment: 4_582.01,
  disposableIncome: 40_000,
  debtToIncomeRatio: 0.1146,
};

const rule = (over: Partial<DecisionRule> = {}): DecisionRule => ({
  id: "r1",
  name: "B-tier fast-track",
  version: 1,
  priority: 200,
  conditions: [{ field: "tierAtApply", op: "=", value: "B" }],
  action: "AUTO_APPROVE",
  reason: "B tier, within limits.",
  active: true,
  ...over,
});

describe("evaluateRules — provenance", () => {
  it("hands back the version of the rule that fired", () => {
    const result = evaluateRules([rule({ version: 4 })], ctx);

    expect(result.matched?.id).toBe("r1");
    expect(result.matched?.version).toBe(4);
  });

  it("names the version that actually matched, not the highest one", () => {
    /*
     * Two rules, different revisions. A decision that reported "the
     * newest rule version in the catalog" would be wrong in exactly the
     * cases that get audited: the ones where an older, stricter rule
     * caught the application first.
     */
    const result = evaluateRules(
      [
        rule({
          id: "block",
          name: "F tier auto-reject",
          version: 7,
          priority: 10,
          conditions: [{ field: "tierAtApply", op: "=", value: "F" }],
          action: "AUTO_REJECT",
        }),
        rule({ id: "fast", version: 2, priority: 200 }),
      ],
      ctx,
    );

    expect(result.matched?.id).toBe("fast");
    expect(result.matched?.version).toBe(2);
  });

  it("matches nothing when no rule applies, and says so", () => {
    // The null case has to stay distinguishable from "the engine never
    // ran" — a loan routed to manual review WAS evaluated, and that is
    // itself a finding.
    const result = evaluateRules(
      [rule({ conditions: [{ field: "tierAtApply", op: "=", value: "A" }] })],
      ctx,
    );

    expect(result.matched).toBeNull();
    expect(result.action).toBe("MANUAL_REVIEW");
  });

  it("ignores a paused rule even when it would have matched", () => {
    const result = evaluateRules([rule({ active: false })], ctx);

    expect(result.matched).toBeNull();
  });

  it("carries the version through a replayed historical set", () => {
    /*
     * `asOf` reconstructs the rules as they stood and feeds them through
     * this same function, so "what would the March rules have said?" is
     * a computed answer. It is only worth anything if the replay names
     * the March version rather than today's.
     */
    const march = [rule({ version: 1, priority: 200 })];
    const today = [rule({ version: 5, priority: 200 })];

    expect(evaluateRules(march, ctx).matched?.version).toBe(1);
    expect(evaluateRules(today, ctx).matched?.version).toBe(5);
  });
});
