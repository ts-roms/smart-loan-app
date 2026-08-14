import { describe, expect, it } from "vitest";

import {
  DEFAULT_RULES,
  TOTAL_EXPOSURE_CEILING_PLACEHOLDER,
  evaluateRules,
  type DecisionRule,
  type DecisioningContext,
} from "./index";

/**
 * The safety property for wiring consolidated exposure (§53) into
 * decisioning: **it changes nobody's outcome until a human configures a
 * rule that reads it.**
 *
 * This is the whole risk of the change. Exposure feeding the engine is
 * a capability, and capabilities are neutral; a THRESHOLD is a policy,
 * and a policy declines people. Shipping a plausible-looking default
 * ceiling would have meant this commit quietly started rejecting
 * borrowers on a number nobody chose — which §50 forbids in as many
 * words: automation must not independently approve or reject.
 *
 * So the claim under test is not "the new fields are computed
 * correctly" (that is `affordability.test.ts`). It is the negative one,
 * which is harder and matters more: with the shipped rule set, a
 * borrower ₱2.15M into the coop across four loans and a first-time
 * borrower with identical everything-else get the SAME decision, from
 * the SAME rule. Then, and only then, that the ceiling works once
 * somebody sets it.
 */

/** DEFAULT_RULES as the catalog inserts them — ids and versions assigned. */
const shipped: DecisionRule[] = DEFAULT_RULES.map((r, i) => ({
  ...r,
  id: `rule-${i}`,
  version: 1,
}));

/**
 * A first-time borrower: nothing owed anywhere.
 *
 * `satisfies` rather than a type annotation — the annotation would make
 * every field optional on spread, and `baseCtx` would stop being a
 * complete `DecisioningContext` without anything saying so.
 */
const noExposure = {
  existingExposure: 0,
  existingExposureOutstanding: 0,
  existingPastDue: 0,
  existingExposureLoans: 0,
  existingWrittenOff: 0,
  existingMonthlyObligations: 0,
  disposableIncome: 40_000,
  debtToIncomeRatio: 0.1182,
} satisfies Partial<DecisioningContext>;

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
  ...noExposure,
  totalExposureAfterLoan: 50_000,
  newLoanInstallment: 4_729.5,
};

const ctx = (over: Partial<DecisioningContext> = {}): DecisioningContext => ({
  ...baseCtx,
  ...over,
});

/**
 * The borrower from the §53 brief: ₱2.15M across four existing loans,
 * two instalments behind, with a write-off in their history. Every
 * exposure field is loud, and the affordability figures are what the
 * §16 fold produces from them — a DTI over 100% and a disposable income
 * that is already negative before this application is considered.
 *
 * Nothing in the shipped rule set looks at any of it. That is the test.
 */
const heavyExposure: Partial<DecisioningContext> = {
  existingExposure: 2_150_000,
  existingExposureOutstanding: 2_480_000,
  existingPastDue: 84_000,
  existingExposureLoans: 4,
  existingWrittenOff: 175_000,
  totalExposureAfterLoan: 2_200_000,
  existingMonthlyObligations: 62_000,
  disposableIncome: -22_000,
  debtToIncomeRatio: 1.6682,
};

/** Every combination the shipped rule set could ever see. */
function* everyContext() {
  const tiers = ["A", "B", "C", "D", "F"] as const;
  const amlStatuses = [
    "CLEAR",
    "PENDING",
    "MATCH",
    "REVIEW",
    "OVERRIDDEN",
  ] as const;
  for (const tierAtApply of tiers)
    for (const amlStatus of amlStatuses)
      for (const kycComplete of [true, false])
        for (const principal of [1_000, 50_000, 100_000, 200_000, 500_000])
          yield ctx({ tierAtApply, amlStatus, kycComplete, principal });
}

// ─── The property ──────────────────────────────────────────────────────

describe("exposure is inert until a rule is configured to read it", () => {
  it("decides identically for a ₱2.15M borrower and a first-time one", () => {
    for (const clean of everyContext()) {
      const loaded = { ...clean, ...heavyExposure };

      const before = evaluateRules(shipped, clean);
      const after = evaluateRules(shipped, loaded);

      // Not just the same action — the same RULE. An outcome that
      // matched by a different route would be a behaviour change that
      // happened to land on the same verdict, and would drift apart the
      // moment the policy was retuned.
      expect(
        after.action,
        `action moved: tier=${clean.tierAtApply} aml=${clean.amlStatus} ` +
          `kyc=${clean.kycComplete} principal=${clean.principal}`,
      ).toBe(before.action);
      expect(after.matched?.id).toBe(before.matched?.id);
      expect(after.matched?.version).toBe(before.matched?.version);
      expect(after.reason).toBe(before.reason);
    }
  });

  it("is unmoved by any single exposure field, swept independently", () => {
    /*
     * The sweep above moves every field at once, which would hide a
     * rule that reacted to one of them and was cancelled out by
     * another. Each field is therefore also pushed on its own, through
     * values spanning a first-time borrower to an implausible one.
     */
    const fields = [
      "existingExposure",
      "existingExposureOutstanding",
      "existingPastDue",
      "existingExposureLoans",
      "existingWrittenOff",
      "totalExposureAfterLoan",
      "existingMonthlyObligations",
      "newLoanInstallment",
      "disposableIncome",
      "debtToIncomeRatio",
    ] as const;

    const baseline = evaluateRules(shipped, baseCtx);

    for (const field of fields) {
      for (const value of [-500_000, 0, 1, 50_000, 10_000_000]) {
        const r = evaluateRules(shipped, ctx({ [field]: value }));
        expect(r.action, `${field}=${value} changed the action`).toBe(
          baseline.action,
        );
        expect(r.matched?.id, `${field}=${value} changed the rule`).toBe(
          baseline.matched?.id,
        );
      }
    }
  });

  it("still fast-tracks a tier-A member who is already ₱2M in", () => {
    /*
     * Stated as an example rather than a sweep because it is the
     * uncomfortable one, and someone reading this file should meet it
     * head on: as shipped, this borrower is STILL recommended for
     * approval. The engine can now see the ₱2.15M — it is on the
     * decision record — but no rule refuses on it, because refusing is
     * a policy decision and nobody has made it yet.
     *
     * When this assertion starts failing, someone has configured a
     * ceiling. That is the intended way for it to break.
     */
    const r = evaluateRules(shipped, ctx(heavyExposure));
    expect(r.action).toBe("AUTO_APPROVE");
    expect(r.matched?.name).toBe("A tier fast-track");
  });
});

// ─── The shipped ceiling rule is doubly inert ──────────────────────────

describe("the shipped total-exposure ceiling", () => {
  const template = DEFAULT_RULES.find((r) =>
    r.conditions.some((c) => c.field === "totalExposureAfterLoan"),
  );

  it("ships in the catalog so an operator can find it", () => {
    // The primitive has to be discoverable. A capability nobody knows
    // to ask for is one that gets hard-coded into the service layer
    // instead, which is what §50 is trying to prevent.
    expect(template).toBeDefined();
  });

  it("ships switched off", () => {
    expect(template?.active).toBe(false);
  });

  it("ships at a threshold no application reaches", () => {
    /*
     * Belt and braces, and deliberately redundant. `active: false` is
     * already enough to make it inert — this second guard is for the
     * reviewer who flips the switch to "see what it does" without
     * reading the reason string.
     */
    const cond = template?.conditions[0];
    expect(cond?.op).toBe(">");
    expect(cond?.value).toBe(TOTAL_EXPOSURE_CEILING_PLACEHOLDER);

    const armedButUnedited: DecisionRule[] = shipped.map((r) =>
      r.conditions.some((c) => c.field === "totalExposureAfterLoan")
        ? { ...r, active: true }
        : r,
    );
    // Switched on, unedited, against the heaviest borrower in this file.
    const r = evaluateRules(armedButUnedited, ctx(heavyExposure));
    expect(r.matched?.name).not.toMatch(/exposure ceiling/i);
  });

  it("routes to a human rather than rejecting, once configured", () => {
    // §50 again: a concentration breach has good answers — collateral,
    // a board approval — and the engine must not close the question.
    expect(template?.action).toBe("MANUAL_REVIEW");
  });

  it("outranks both fast-tracks", () => {
    /*
     * A ceiling behind the tier-A rule is not a ceiling. The whole
     * point is to catch the borrower whose score is excellent and whose
     * total book is not.
     */
    const fastTracks = DEFAULT_RULES.filter((r) => r.action === "AUTO_APPROVE");
    for (const ft of fastTracks) {
      expect(template!.priority).toBeLessThan(ft.priority);
    }
  });
});

// ─── And it bites once somebody sets it ────────────────────────────────

describe("a configured exposure ceiling", () => {
  /** The template as an operator would leave it: on, with a real limit. */
  const configured = (limit: number): DecisionRule[] =>
    shipped.map((r) =>
      r.conditions.some((c) => c.field === "totalExposureAfterLoan")
        ? {
            ...r,
            active: true,
            version: 2,
            conditions: [
              { field: "totalExposureAfterLoan", op: ">", value: limit },
            ],
          }
        : r,
    );

  it("catches the ₱2.15M borrower the shipped set waves through", () => {
    const rules = configured(1_000_000);
    const loaded = ctx(heavyExposure);

    expect(evaluateRules(shipped, loaded).action).toBe("AUTO_APPROVE");

    const r = evaluateRules(rules, loaded);
    expect(r.action).toBe("MANUAL_REVIEW");
    expect(r.matched?.name).toMatch(/exposure ceiling/i);
    expect(r.reason).toMatch(/single-borrower ceiling/i);
  });

  it("leaves the first-time borrower alone", () => {
    // The other half of "it bites": a ceiling that caught everybody
    // would pass the test above and be useless.
    const r = evaluateRules(configured(1_000_000), baseCtx);
    expect(r.action).toBe("AUTO_APPROVE");
    expect(r.matched?.name).toBe("A tier fast-track");
  });

  it("is exclusive at the boundary — the limit itself is allowed", () => {
    /*
     * `>` not `>=`. A limit of ₱1M means ₱1M is permitted; a borrower
     * landing exactly on the board's number is inside it, not over it.
     */
    const rules = configured(1_000_000);
    const at = ctx({ ...heavyExposure, totalExposureAfterLoan: 1_000_000 });
    const over = ctx({
      ...heavyExposure,
      totalExposureAfterLoan: 1_000_000.01,
    });

    expect(evaluateRules(rules, at).action).toBe("AUTO_APPROVE");
    expect(evaluateRules(rules, over).action).toBe("MANUAL_REVIEW");
  });

  it("carries its own version out, so the decision stays explainable", () => {
    /*
     * §20/§21. The limit an operator sets today is not the limit that
     * declined this borrower in March, and a stamped decision has to
     * name which one applied — see provenance.test.ts for the general
     * property. Asserted here too because a rule whose threshold is the
     * whole policy is the one where "which version?" is most likely to
     * be the question asked.
     */
    const r = evaluateRules(configured(1_000_000), ctx(heavyExposure));
    expect(r.matched?.version).toBe(2);
  });

  it("does not need a new field type — it is the existing DSL", () => {
    // §21 wants rules versioned, effective-dated and testable. The
    // exposure ceiling gets all three for free precisely because it is
    // an ordinary `{ field, op, value }` row and not a special case
    // wired into the evaluator.
    const cond = configured(750_000)
      .flatMap((r) => r.conditions)
      .find((c) => c.field === "totalExposureAfterLoan");
    expect(cond).toEqual({
      field: "totalExposureAfterLoan",
      op: ">",
      value: 750_000,
    });
  });
});

// ─── Rules can read the affordability fields too ───────────────────────

describe("affordability as a rule input (§16)", () => {
  it("supports a DTI ceiling expressed in the same DSL", () => {
    /*
     * Not shipped — same reason as the exposure ceiling: 50% is a
     * common PH coop threshold, and "common" is not "chosen by this
     * lender's board". Tested so the primitive is known to work when
     * one is set.
     */
    const dtiRule: DecisionRule = {
      id: "dti",
      name: "DTI over ceiling",
      version: 1,
      priority: 60,
      conditions: [{ field: "debtToIncomeRatio", op: ">", value: 0.5 }],
      action: "MANUAL_REVIEW",
      reason: "Debt-to-income above the configured ceiling.",
      active: true,
    };

    // The borrower already carrying ₱62k/month of amortizations.
    expect(
      evaluateRules([...shipped, dtiRule], ctx(heavyExposure)).action,
    ).toBe("MANUAL_REVIEW");
    // The one carrying none.
    expect(evaluateRules([...shipped, dtiRule], baseCtx).action).toBe(
      "AUTO_APPROVE",
    );
  });

  it("supports refusing on a negative disposable income", () => {
    const rule: DecisionRule = {
      id: "disposable",
      name: "No disposable income",
      version: 1,
      priority: 55,
      conditions: [{ field: "disposableIncome", op: "<", value: 0 }],
      action: "MANUAL_REVIEW",
      reason: "Existing obligations already exceed income.",
      active: true,
    };

    expect(evaluateRules([...shipped, rule], ctx(heavyExposure)).action).toBe(
      "MANUAL_REVIEW",
    );
    expect(evaluateRules([...shipped, rule], baseCtx).action).toBe(
      "AUTO_APPROVE",
    );
  });

  it("supports refusing on a prior write-off", () => {
    /*
     * The figure `exposure.ts` calls "the single most important fact
     * about the borrower", and which is deliberately OUTSIDE the
     * exposure total. Before this change it existed only on a profile
     * panel; a rule can now refuse on it.
     */
    const rule: DecisionRule = {
      id: "writeoff",
      name: "Prior write-off",
      version: 1,
      priority: 15,
      conditions: [{ field: "existingWrittenOff", op: ">", value: 0 }],
      action: "MANUAL_REVIEW",
      reason: "This member has previously had a loan written off.",
      active: true,
    };

    expect(evaluateRules([...shipped, rule], ctx(heavyExposure)).action).toBe(
      "MANUAL_REVIEW",
    );
    expect(evaluateRules([...shipped, rule], baseCtx).action).toBe(
      "AUTO_APPROVE",
    );
  });
});
