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
      /*
       * A borrower with an empty book. §53 exposure is a decisioning
       * input now, so the harness has to answer for it — and the
       * default answer is the honest one for a fixture whose loan
       * table is empty: no loans, nothing owed, nothing due monthly.
       * Tests that care about exposure override this.
       */
      exposure: { forDecision: vi.fn(async () => noExposure()) } as never,
      ...overrides,
    } satisfies PreDecisionDeps,
    prisma,
    count,
  };
}

/** What `CustomerExposureRepository.forDecision` returns for an empty book. */
function noExposure() {
  return {
    exposure: {
      loans: [],
      total: {
        principalOutstanding: 0,
        outstanding: 0,
        pastDue: 0,
        activeLoans: 0,
      },
      excluded: {
        loans: 0,
        closedLoans: 0,
        writtenOffLoans: 0,
        writtenOffPrincipal: 0,
      },
    },
    monthlyObligations: 0,
    asOf: new Date(),
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

// ─── §53 exposure reaching the engine ──────────────────────────────────

/**
 * The borrower from the §53 brief: ₱2.15M across four loans, ₱62,000 a
 * month of it, ₱84,000 already in arrears, and a ₱175,000 write-off in
 * their history.
 */
function loadedExposure() {
  return {
    exposure: {
      loans: [],
      total: {
        principalOutstanding: 2_150_000,
        outstanding: 2_480_000,
        pastDue: 84_000,
        activeLoans: 4,
      },
      excluded: {
        loans: 2,
        closedLoans: 1,
        writtenOffLoans: 1,
        writtenOffPrincipal: 175_000,
      },
    },
    monthlyObligations: 62_000,
    asOf: new Date(),
  };
}

/** A customer on file with a real income. */
function onFile(prisma: { customer: { findUnique: unknown } }) {
  prisma.customer.findUnique = vi.fn(async () => ({
    id: "cust-1",
    dateOfBirth: new Date(Date.now() - 40 * 365.25 * 86_400_000),
    monthlyIncome: 80_000,
  }));
}

describe("evaluateForCustomer — consolidated exposure as an input", () => {
  it("carries the borrower's whole book onto the context", async () => {
    /*
     * The gap §53 named. Exposure was computed and displayed on a
     * profile page; decisioning never saw it, so a member ₱2.15M into
     * the coop was assessed as though those four loans did not exist.
     *
     * These are the figures that land verbatim in `decisionContext` at
     * the apply() call site — §20's "inputs used at decision time",
     * beside the rule version that read them.
     */
    const { deps, prisma } = makeDeps();
    onFile(prisma);
    deps.exposure.forDecision = vi.fn(async () => loadedExposure());

    const c = (await evaluateForCustomer(deps, "cust-1", TERMS))!.context;

    expect(c.existingExposure).toBe(2_150_000);
    expect(c.existingExposureOutstanding).toBe(2_480_000);
    expect(c.existingPastDue).toBe(84_000);
    expect(c.existingExposureLoans).toBe(4);
    expect(c.existingWrittenOff).toBe(175_000);
  });

  it("adds this application to the book for the ceiling field", async () => {
    const { deps, prisma } = makeDeps();
    onFile(prisma);
    deps.exposure.forDecision = vi.fn(async () => loadedExposure());

    const c = (await evaluateForCustomer(deps, "cust-1", TERMS))!.context;

    // ₱2.15M already out, ₱50k being asked for.
    expect(c.totalExposureAfterLoan).toBe(2_200_000);
  });

  it("subtracts existing obligations from disposable income (§16)", async () => {
    const { deps, prisma } = makeDeps();
    onFile(prisma);
    deps.exposure.forDecision = vi.fn(async () => loadedExposure());

    const c = (await evaluateForCustomer(deps, "cust-1", TERMS))!.context;

    expect(c.existingMonthlyObligations).toBe(62_000);
    // ₱80,000 income − ₱62,000 of existing amortizations. Before this,
    // the engine's view of the same borrower was ₱80,000 flat.
    expect(c.disposableIncome).toBe(18_000);
    expect(c.debtToIncomeRatio).toBeGreaterThan(0.75);
  });

  it("does not subtract arrears a second time", async () => {
    /*
     * ₱84,000 is already overdue and ₱62,000 is next month's
     * amortization. They are different money and they arrive on
     * different fields; a disposable income of ₱80,000 − ₱62,000 −
     * ₱84,000 would understate this borrower by the entire arrears
     * balance. The repository draws the window forward from `asOf` so
     * the two can never intersect — see
     * customer-exposure.decisioning.test.ts.
     */
    const { deps, prisma } = makeDeps();
    onFile(prisma);
    deps.exposure.forDecision = vi.fn(async () => loadedExposure());

    const c = (await evaluateForCustomer(deps, "cust-1", TERMS))!.context;

    expect(c.disposableIncome).toBe(18_000);
    expect(c.existingPastDue).toBe(84_000);
  });

  it("leaves the active-loan COUNT alone", async () => {
    /*
     * `existingActiveLoans` counts DISBURSED / ACTIVE / DEFAULTED;
     * exposure also counts APPROVED, so the two legitimately disagree.
     * Redefining the old field in the new one's terms would silently
     * move every rule already written against it, which is the one
     * thing adding exposure must not do.
     */
    const { deps, prisma, count } = makeDeps();
    onFile(prisma);
    deps.exposure.forDecision = vi.fn(async () => loadedExposure());

    const c = (await evaluateForCustomer(deps, "cust-1", TERMS))!.context;

    expect(count).toHaveBeenCalled();
    expect(c.existingActiveLoans).toBe(0);
    expect(c.existingExposureLoans).toBe(4);
  });

  it("reads exposure once, on the same parallel pass as everything else", async () => {
    // One read, so the figure stamped onto the record is the figure the
    // rules acted on. A second lookup could straddle an incoming
    // payment and disagree with the first.
    const { deps, prisma } = makeDeps();
    onFile(prisma);
    const forDecision = vi.fn(async () => loadedExposure());
    deps.exposure.forDecision = forDecision;

    await evaluateForCustomer(deps, "cust-1", TERMS);

    expect(forDecision).toHaveBeenCalledTimes(1);
    expect(forDecision).toHaveBeenCalledWith("cust-1");
  });

  it("reports zeros for a member with an empty book", async () => {
    const { deps, prisma } = makeDeps();
    onFile(prisma);

    const c = (await evaluateForCustomer(deps, "cust-1", TERMS))!.context;

    expect(c.existingExposure).toBe(0);
    expect(c.existingMonthlyObligations).toBe(0);
    expect(c.totalExposureAfterLoan).toBe(50_000);
    // No obligations means disposable income is simply the income.
    expect(c.disposableIncome).toBe(80_000);
  });
});

describe("the new loan's own instalment", () => {
  it("uses the product's interest method rather than assuming declining", async () => {
    /*
     * A FLAT product's instalment is materially larger than the
     * declining-balance formula suggests, and PH coops sell plenty of
     * them. A DTI computed off the wrong one is wrong in the lenient
     * direction on exactly those products.
     */
    const declining = makeDeps();
    onFile(declining.prisma);
    const flat = makeDeps();
    onFile(flat.prisma);
    flat.prisma.loanProduct.findUnique = vi.fn(async () => ({
      interestMethod: "FLAT",
      paymentFrequency: "MONTHLY",
      requiredKycDocs: [],
    })) as never;

    const d = (await evaluateForCustomer(declining.deps, "cust-1", TERMS))!
      .context;
    const f = (await evaluateForCustomer(flat.deps, "cust-1", TERMS))!.context;

    expect(f.newLoanInstallment).toBeGreaterThan(d.newLoanInstallment);
  });

  it("normalises a weekly product to a monthly figure", async () => {
    /*
     * §16's disposable income is monthly. A weekly loan's ₱500
     * instalment is not comparable to a monthly loan's ₱500 one, and
     * subtracting it as though it were would understate the borrower's
     * commitment roughly four-fold.
     */
    const monthly = makeDeps();
    onFile(monthly.prisma);
    const weekly = makeDeps();
    onFile(weekly.prisma);
    weekly.prisma.loanProduct.findUnique = vi.fn(async () => ({
      interestMethod: "DECLINING",
      paymentFrequency: "WEEKLY",
      requiredKycDocs: [],
    })) as never;

    const m = (await evaluateForCustomer(monthly.deps, "cust-1", TERMS))!
      .context;
    const w = (await evaluateForCustomer(weekly.deps, "cust-1", TERMS))!
      .context;

    // Same principal, same term, same rate — so the monthly cost should
    // land in the same neighbourhood however often it is collected.
    expect(w.newLoanInstallment).toBeGreaterThan(m.newLoanInstallment * 0.9);
    expect(w.newLoanInstallment).toBeLessThan(m.newLoanInstallment * 1.1);
  });
});

describe("evaluateForProspect — exposure it genuinely cannot have", () => {
  it("reports zero exposure rather than an unknown", async () => {
    /*
     * A prospect has no Customer row, so they cannot hold a loan with
     * THIS lender — zero is a fact, not a default. Debt held elsewhere
     * is unknown, but it is equally unknown for members; the system has
     * never seen it for anybody.
     */
    const { deps } = makeDeps();
    const outcome = await evaluateForProspect(
      deps,
      { monthlyIncome: 30_000, applicantAge: 41 },
      TERMS,
    );

    expect(outcome.context.existingExposure).toBe(0);
    expect(outcome.context.existingMonthlyObligations).toBe(0);
    expect(outcome.context.existingWrittenOff).toBe(0);
    expect(outcome.context.totalExposureAfterLoan).toBe(50_000);
    expect(outcome.context.disposableIncome).toBe(30_000);
  });

  it("does not go looking for the exposure of a customer who does not exist", async () => {
    const { deps } = makeDeps();
    const forDecision = vi.fn(async () => noExposure());
    deps.exposure.forDecision = forDecision;

    await evaluateForProspect(
      deps,
      { monthlyIncome: 30_000, applicantAge: 41 },
      TERMS,
    );

    expect(forDecision).not.toHaveBeenCalled();
  });

  it("still quotes an instalment, so the DTI means something", async () => {
    const { deps } = makeDeps();
    const outcome = await evaluateForProspect(
      deps,
      { monthlyIncome: 30_000, applicantAge: 41 },
      TERMS,
    );

    expect(outcome.context.newLoanInstallment).toBeGreaterThan(0);
    expect(outcome.context.debtToIncomeRatio).toBeGreaterThan(0);
  });
});

function outcomeCodes(outcome: { anomalies: Array<{ code: string }> }) {
  return outcome.anomalies.map((a) => a.code);
}
