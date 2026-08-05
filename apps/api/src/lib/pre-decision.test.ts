/**
 * Pre-decision evaluation — the two context builders behind
 * /loans/dry-run and /pre-assessments.
 *
 * What's worth protecting here isn't the rule engine (that has its own
 * tests in @loan/decisioning) — it's what the two entry points *claim to
 * know*:
 *
 *   1. A prospect has no credit file, no AML screen and no verified
 *      documents. If any of those silently defaulted to something
 *      optimistic — `kycComplete: true`, a made-up score — a walk-in
 *      would be quoted a verdict the lender can't stand behind.
 *   2. A prospect has no Customer row, so the velocity check must not
 *      run unscoped. Counting *everyone's* recent applications would
 *      flag every prospect at a busy branch.
 *   3. A missing customer resolves to null rather than to a verdict
 *      built from an empty record.
 */

import { describe, expect, it, vi } from "vitest";

import {
  evaluateForCustomer,
  evaluateForProspect,
  toVerdict,
  type PreDecisionDeps,
} from "./pre-decision";

const TERMS = {
  productCode: "SALARY",
  principal: 50_000,
  termMonths: 12,
  annualInterestRate: 0.24,
};

/**
 * Deps with no rules configured and an empty loan book. `evaluateRules`
 * with no matching rule returns MANUAL_REVIEW, which is the arm we want
 * for context assertions — it keeps the rules out of the way.
 */
function makeDeps(overrides: Partial<PreDecisionDeps> = {}) {
  const count = vi.fn(async () => 0);
  const findMany = vi.fn(async () => []);
  const prisma = {
    customer: { findUnique: vi.fn(async () => null) },
    loanProduct: { findUnique: vi.fn(async () => null) },
    loanApplication: { findMany, count },
  };
  return {
    deps: {
      prisma: prisma as never,
      screening: { latestForCustomer: vi.fn(async () => null) } as never,
      scores: { latestForCustomer: vi.fn(async () => null) } as never,
      kyc: { listForCustomer: vi.fn(async () => []) } as never,
      rules: {
        listActive: vi.fn(async () => []),
        toEvaluable: () => [],
      } as never,
      ...overrides,
    } satisfies PreDecisionDeps,
    prisma,
    count,
  };
}

describe("toVerdict — rule action to the three outcomes shown", () => {
  it("maps auto actions straight through", () => {
    expect(toVerdict("AUTO_APPROVE")).toBe("APPROVE");
    expect(toVerdict("AUTO_REJECT")).toBe("REJECT");
  });

  it("sends manual review to REVIEW", () => {
    expect(toVerdict("MANUAL_REVIEW")).toBe("REVIEW");
  });
});

describe("evaluateForProspect — what the engine is told it doesn't know", () => {
  it("carries nulls for score, tier and AML rather than optimistic defaults", async () => {
    const { deps } = makeDeps();
    const outcome = await evaluateForProspect(
      deps,
      { monthlyIncome: 30_000, applicantAge: 41 },
      TERMS,
    );

    expect(outcome.context.creditScoreAtApply).toBeNull();
    expect(outcome.context.tierAtApply).toBeNull();
    expect(outcome.context.amlStatus).toBeNull();
    // Not "unknown, so assume fine" — an unverified applicant IS
    // KYC-incomplete, and rules gated on it must fire.
    expect(outcome.context.kycComplete).toBe(false);
    expect(outcome.context.existingActiveLoans).toBe(0);
  });

  it("passes the caller's declared income and age through unchanged", async () => {
    const { deps } = makeDeps();
    const outcome = await evaluateForProspect(
      deps,
      { monthlyIncome: 30_000, applicantAge: 41 },
      TERMS,
    );

    expect(outcome.context.monthlyIncome).toBe(30_000);
    expect(outcome.context.customerAge).toBe(41);
    expect(outcome.context.productCode).toBe("SALARY");
  });

  it("returns no gates — there is no customer to have AML or KYC on", async () => {
    const { deps } = makeDeps();
    const outcome = await evaluateForProspect(
      deps,
      { monthlyIncome: 30_000, applicantAge: 41 },
      TERMS,
    );

    expect(outcome.gates).toBeNull();
  });

  it("skips the velocity count instead of running it unscoped", async () => {
    const { deps, count } = makeDeps();
    await evaluateForProspect(
      deps,
      { monthlyIncome: 30_000, applicantAge: 41 },
      TERMS,
    );

    // An unscoped count would return every recent application in the
    // tenant and flag APPLICANT_VELOCITY on every prospect.
    expect(count).not.toHaveBeenCalled();
    expect(
      outcomeCodes(
        await evaluateForProspect(
          deps,
          { monthlyIncome: 30_000, applicantAge: 41 },
          TERMS,
        ),
      ),
    ).not.toContain("APPLICANT_VELOCITY");
  });
});

describe("evaluateForCustomer — missing subject", () => {
  it("returns null so the caller can 404 rather than assessing a ghost", async () => {
    const { deps } = makeDeps();
    const outcome = await evaluateForCustomer(deps, "missing-id", TERMS);
    expect(outcome).toBeNull();
  });

  it("reads income, age and AML status off the customer record", async () => {
    const { deps, prisma } = makeDeps();
    prisma.customer.findUnique = vi.fn(async () => ({
      id: "cust-1",
      // 30 years ago — the helper floors to whole years, so this is
      // stable regardless of when the suite runs.
      dateOfBirth: new Date(Date.now() - 30 * 365.25 * 86_400_000),
      monthlyIncome: 45_000,
    })) as never;
    deps.screening.latestForCustomer = vi.fn(async () => ({
      status: "MATCH",
    })) as never;

    const outcome = await evaluateForCustomer(deps, "cust-1", TERMS);

    expect(outcome?.context.monthlyIncome).toBe(45_000);
    expect(outcome?.context.customerAge).toBe(30);
    expect(outcome?.context.amlStatus).toBe("MATCH");
    // An active MATCH is a hard block on /apply, so it has to surface as
    // a gate and not only inside the verdict.
    expect(outcome?.gates?.amlMatch).toBe(true);
  });
});

function outcomeCodes(outcome: { anomalies: Array<{ code: string }> }) {
  return outcome.anomalies.map((a) => a.code);
}
