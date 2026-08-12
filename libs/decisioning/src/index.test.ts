/**
 * Decisioning — the rule engine that auto-approves, auto-rejects, or routes
 * a loan application to a human. It had no tests.
 *
 * The valuable assertions here are not "rule X fires for input Y" — those
 * change whenever a lender tunes their policy. They're the *safety
 * properties* that must hold no matter how the rules are tuned:
 *
 *   - an application can never be auto-approved with an AML match
 *   - an application can never be auto-approved without completed KYC
 *   - anything unmatched falls through to a human, not to an approval
 *
 * Those are swept across the whole context space rather than spot-checked,
 * because the failure mode that matters is a *combination* nobody thought
 * to write an example for.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RULES,
  evaluateRules,
  type DecisionRule,
  type DecisioningContext,
} from "./index";

/** DEFAULT_RULES minus the `id` and `version` the catalog assigns. */
const rules: DecisionRule[] = DEFAULT_RULES.map((r, i) => ({
  ...r,
  id: `rule-${i}`,
  version: 1,
}));

const baseCtx: DecisioningContext = {
  productCode: "SALARY",
  principal: 50_000,
  termMonths: 12,
  annualInterestRate: 0.24,
  tierAtApply: "A",
  creditScoreAtApply: 780,
  amlStatus: "CLEAR",
  kycComplete: true,
  customerAge: 35,
  monthlyIncome: 40_000,
  existingActiveLoans: 0,
};

const ctx = (over: Partial<DecisioningContext> = {}): DecisioningContext => ({
  ...baseCtx,
  ...over,
});

// ─── Safety properties, swept ──────────────────────────────────────────

describe("safety properties (swept across the context space)", () => {
  const tiers = ["A", "B", "C", "D", "F"] as const;
  const amlStatuses = [
    "CLEAR",
    "PENDING",
    "MATCH",
    "REVIEW",
    "OVERRIDDEN",
  ] as const;
  const kycStates = [true, false];
  const principals = [1_000, 50_000, 100_000, 200_000, 500_000];

  /** Every combination the rule set could ever see. */
  function* everyContext() {
    for (const tierAtApply of tiers)
      for (const amlStatus of amlStatuses)
        for (const kycComplete of kycStates)
          for (const principal of principals)
            yield ctx({ tierAtApply, amlStatus, kycComplete, principal });
  }

  it("never auto-approves an application with an unresolved AML match", () => {
    for (const c of everyContext()) {
      if (c.amlStatus !== "MATCH") continue;
      const r = evaluateRules(rules, c);
      expect(
        r.action,
        `AML MATCH approved: tier=${c.tierAtApply} kyc=${c.kycComplete} principal=${c.principal}`,
      ).not.toBe("AUTO_APPROVE");
    }
  });

  it("never auto-approves without completed KYC", () => {
    for (const c of everyContext()) {
      if (c.kycComplete) continue;
      const r = evaluateRules(rules, c);
      expect(
        r.action,
        `approved without KYC: tier=${c.tierAtApply} aml=${c.amlStatus} principal=${c.principal}`,
      ).not.toBe("AUTO_APPROVE");
    }
  });

  it("only ever auto-approves tier A or B", () => {
    for (const c of everyContext()) {
      const r = evaluateRules(rules, c);
      if (r.action !== "AUTO_APPROVE") continue;
      expect(
        ["A", "B"],
        `approved tier ${c.tierAtApply} (aml=${c.amlStatus} principal=${c.principal})`,
      ).toContain(c.tierAtApply);
    }
  });

  it("only auto-approves when AML is genuinely resolved", () => {
    for (const c of everyContext()) {
      const r = evaluateRules(rules, c);
      if (r.action !== "AUTO_APPROVE") continue;
      // PENDING and REVIEW are unresolved — approving through either would
      // mean lending before screening finished.
      expect(
        ["CLEAR", "OVERRIDDEN"],
        `approved with amlStatus=${c.amlStatus}`,
      ).toContain(c.amlStatus);
    }
  });

  it("always returns one of the three known actions", () => {
    for (const c of everyContext()) {
      expect(["AUTO_APPROVE", "AUTO_REJECT", "MANUAL_REVIEW"]).toContain(
        evaluateRules(rules, c).action,
      );
    }
  });
});

// ─── Fail-safe behaviour ───────────────────────────────────────────────

describe("fail-safe defaults", () => {
  it("routes to manual review when no rule matches", () => {
    const r = evaluateRules([], ctx());
    expect(r.action).toBe("MANUAL_REVIEW");
    expect(r.matched).toBeNull();
  });

  it("ignores inactive rules", () => {
    const disabled = rules.map((r) => ({ ...r, active: false }));
    const r = evaluateRules(disabled, ctx({ amlStatus: "MATCH" }));
    // With every rule off, even an AML match falls through — to a human,
    // never to an approval.
    expect(r.action).toBe("MANUAL_REVIEW");
  });

  it("still refuses to auto-approve an AML match if the AML rule is disabled", () => {
    // Defence in depth: the approve rules carry their own AML condition, so
    // removing the hard block doesn't open a path to approval.
    const withoutAmlBlock = rules.filter((r) => r.name !== "AML hard-block");
    const r = evaluateRules(withoutAmlBlock, ctx({ amlStatus: "MATCH" }));
    expect(r.action).not.toBe("AUTO_APPROVE");
  });

  it("does not mutate the caller's rule array", () => {
    const input = [...rules];
    const order = input.map((r) => r.id);
    evaluateRules(input, ctx());
    expect(input.map((r) => r.id)).toEqual(order);
  });

  it("treats a malformed `in` condition as not matching", () => {
    const malformed: DecisionRule[] = [
      {
        id: "bad",
        version: 1,
        name: "malformed",
        priority: 1,
        // `in` expects an array; a bare string is a config error.
        conditions: [{ field: "amlStatus", op: "in", value: "CLEAR" }],
        action: "AUTO_APPROVE",
        reason: "should not fire",
        active: true,
      },
    ];
    const r = evaluateRules(malformed, ctx());
    // Not matching means it falls through to manual review — the safe
    // direction for an approve rule. Worth knowing this is the behaviour:
    // a malformed *reject* rule would likewise silently stop blocking.
    expect(r.action).toBe("MANUAL_REVIEW");
  });
});

// ─── Ordering ──────────────────────────────────────────────────────────

describe("rule ordering", () => {
  it("applies the lowest priority number first", () => {
    // AML (10) outranks KYC (20): a customer who is both matched and
    // KYC-incomplete is rejected, not sent to review.
    const r = evaluateRules(
      rules,
      ctx({ amlStatus: "MATCH", kycComplete: false }),
    );
    expect(r.action).toBe("AUTO_REJECT");
    expect(r.matched?.name).toBe("AML hard-block");
  });

  it("is deterministic when two rules share a priority", () => {
    const tied: DecisionRule[] = [
      {
        id: "first",
        version: 1,
        name: "first",
        priority: 50,
        conditions: [],
        action: "AUTO_REJECT",
        reason: "first",
        active: true,
      },
      {
        id: "second",
        version: 1,
        name: "second",
        priority: 50,
        conditions: [],
        action: "AUTO_APPROVE",
        reason: "second",
        active: true,
      },
    ];
    // Array#sort is stable, so insertion order breaks the tie — the same
    // input must not decide differently between runs.
    const seen = new Set(
      Array.from({ length: 20 }, () => evaluateRules(tied, ctx()).matched?.id),
    );
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe("first");
  });

  it("reports the matching rule and its reason", () => {
    const r = evaluateRules(rules, ctx({ tierAtApply: "F" }));
    expect(r.action).toBe("AUTO_REJECT");
    expect(r.matched?.name).toBe("F tier auto-reject");
    expect(r.reason).toMatch(/below underwriting threshold/i);
  });
});

// ─── Boundaries on the shipped policy ──────────────────────────────────

describe("DEFAULT_RULES boundaries", () => {
  it("fast-tracks tier A at exactly the ₱200k ceiling, but not a peso over", () => {
    expect(evaluateRules(rules, ctx({ principal: 200_000 })).action).toBe(
      "AUTO_APPROVE",
    );
    expect(evaluateRules(rules, ctx({ principal: 200_001 })).action).toBe(
      "MANUAL_REVIEW",
    );
  });

  it("fast-tracks tier B at exactly the ₱100k ceiling, but not a peso over", () => {
    const b = { tierAtApply: "B" as const };
    expect(evaluateRules(rules, ctx({ ...b, principal: 100_000 })).action).toBe(
      "AUTO_APPROVE",
    );
    expect(evaluateRules(rules, ctx({ ...b, principal: 100_001 })).action).toBe(
      "MANUAL_REVIEW",
    );
  });

  it("sends tier C to a human either way", () => {
    for (const principal of [1_000, 500_000]) {
      expect(
        evaluateRules(rules, ctx({ tierAtApply: "C", principal })).action,
      ).toBe("MANUAL_REVIEW");
    }
  });

  it("rejects tier F regardless of how clean everything else is", () => {
    const r = evaluateRules(
      rules,
      ctx({ tierAtApply: "F", principal: 1_000, amlStatus: "CLEAR" }),
    );
    expect(r.action).toBe("AUTO_REJECT");
  });
});
