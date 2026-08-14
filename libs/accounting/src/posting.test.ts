import { describe, expect, it } from "vitest";

import { ACCOUNT_CODES } from "./chart";
import {
  allocatePayment,
  buildEntry,
  contributionEntry,
  eclProvisionEntry,
  lateFeeAccrualEntry,
  loanDisbursementEntry,
  loanPaymentEntry,
  penaltyWaiveEntry,
} from "./posting";

/**
 * Journal-entry posting tests. These factories are the spine of the
 * ledger: every loan/coop/ECL movement passes through one of them.
 * The contract that matters most is *balance* — debits must equal
 * credits to the penny — followed by the specific account codes /
 * direction that each kind of movement should produce.
 */

describe("buildEntry — balance enforcement", () => {
  const ANY = new Date("2026-01-15");

  it("accepts a balanced 2-line entry", () => {
    const e = buildEntry({
      entryDate: ANY,
      source: "MANUAL",
      lines: [
        { accountCode: "CASH", debit: 100, credit: 0 },
        { accountCode: "FEE_INCOME", debit: 0, credit: 100 },
      ],
    });
    expect(e.lines).toHaveLength(2);
  });

  it("throws when debits ≠ credits beyond a penny tolerance", () => {
    expect(() =>
      buildEntry({
        entryDate: ANY,
        source: "MANUAL",
        lines: [
          { accountCode: "CASH", debit: 100, credit: 0 },
          { accountCode: "FEE_INCOME", debit: 0, credit: 99.5 },
        ],
      }),
    ).toThrow(/does not balance/);
  });

  it("tolerates sub-penny rounding (debits=credits within ±0.005)", () => {
    expect(() =>
      buildEntry({
        entryDate: ANY,
        source: "MANUAL",
        lines: [
          { accountCode: "CASH", debit: 100.001, credit: 0 },
          { accountCode: "FEE_INCOME", debit: 0, credit: 100.0 },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects a single-sided line (debit AND credit on the same row)", () => {
    expect(() =>
      buildEntry({
        entryDate: ANY,
        source: "MANUAL",
        lines: [
          { accountCode: "CASH", debit: 50, credit: 50 },
          { accountCode: "OTHER", debit: 50, credit: 50 },
        ],
      }),
    ).toThrow(/both debit and credit/);
  });

  it("rejects negative amounts on a line that survives the zero-filter", () => {
    // `buildEntry` drops zero-or-less lines before validating, so a
    // pair of all-negative lines is filtered out and trips the
    // "needs two lines" check first. The negative-amount path is
    // only reachable when a positive line keeps the count ≥ 2.
    expect(() =>
      buildEntry({
        entryDate: ANY,
        source: "MANUAL",
        lines: [
          { accountCode: "CASH", debit: 100, credit: 0 },
          { accountCode: "FEE_INCOME", debit: 0, credit: 100 },
          { accountCode: "OTHER", debit: -5, credit: 0 },
        ],
      }),
    ).toThrow(/negative/);
  });

  it("rejects an entry with fewer than two non-zero lines", () => {
    expect(() =>
      buildEntry({
        entryDate: ANY,
        source: "MANUAL",
        lines: [{ accountCode: "CASH", debit: 100, credit: 0 }],
      }),
    ).toThrow(/at least two lines/);
  });

  it("drops zero-amount lines from the output", () => {
    const e = buildEntry({
      entryDate: ANY,
      source: "MANUAL",
      lines: [
        { accountCode: "CASH", debit: 100, credit: 0 },
        { accountCode: "FEE_INCOME", debit: 0, credit: 100 },
        { accountCode: "OTHER", debit: 0, credit: 0 },
      ],
    });
    expect(e.lines).toHaveLength(2);
    expect(e.lines.find((l) => l.accountCode === "OTHER")).toBeUndefined();
  });
});

describe("loanDisbursementEntry", () => {
  const DATE = new Date("2026-02-01");

  it("books the no-fee case as 2 lines (Loans Receivable debit, Cash credit)", () => {
    const e = loanDisbursementEntry({
      loanId: "L1",
      loanNumber: "LN-2026-000001",
      principal: 100_000,
      disbursedAt: DATE,
    });
    expect(e.lines).toHaveLength(2);
    expect(e.lines[0]?.debit).toBe(100_000);
    expect(e.lines[1]?.credit).toBe(100_000);
    expect(e.source).toBe("LOAN_DISBURSEMENT");
  });

  it("books the with-fee case as 3 lines (Loans Receivable / Cash net / Fee Income)", () => {
    const e = loanDisbursementEntry({
      loanId: "L1",
      loanNumber: "LN-2026-000002",
      principal: 100_000,
      feeTotal: 2_500,
      disbursedAt: DATE,
    });
    expect(e.lines).toHaveLength(3);
    // Loans Receivable still records the full principal owed by the customer.
    expect(e.lines[0]?.debit).toBe(100_000);
    // Cash that actually leaves the till is net of fees.
    expect(e.lines[1]?.credit).toBe(97_500);
    // Fee Income credits the rest.
    expect(e.lines[2]?.credit).toBe(2_500);
  });
});

describe("loanPaymentEntry", () => {
  const DATE = new Date("2026-03-15");

  it("produces a balanced entry that credits Loans Receivable + Interest", () => {
    const e = loanPaymentEntry({
      loanId: "L1",
      loanNumber: "LN-2026-000001",
      paymentId: "P1",
      amount: 1_000,
      principalPortion: 800,
      interestPortion: 200,
      paidOn: DATE,
    });
    // Sum should balance.
    const debits = e.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(debits).toBeCloseTo(1_000, 2);
  });
});

describe("allocatePayment", () => {
  it("clears interest before principal, in installment order", () => {
    const r = allocatePayment(1_500, [
      { interestDue: 300, principalDue: 700 }, // installment 1
      { interestDue: 280, principalDue: 720 }, // installment 2
    ]);
    // 1500 covers all of inst1's interest (300) + principal (700) = 1000,
    // then 280 of inst2's interest, then 220 of inst2's principal.
    expect(r.interest).toBeCloseTo(300 + 280, 2);
    expect(r.principal).toBeCloseTo(700 + 220, 2);
    expect(r.overpayment).toBe(0);
  });

  it("returns the leftover as overpayment when the amount exceeds all due", () => {
    const r = allocatePayment(2_500, [
      { interestDue: 300, principalDue: 700 },
      { interestDue: 280, principalDue: 720 },
    ]);
    expect(r.overpayment).toBeCloseTo(2_500 - (300 + 700 + 280 + 720), 2);
  });

  it("stops cleanly when the amount runs out mid-installment", () => {
    // Cover all of inst1 (1000) + 150 of inst2's interest, no principal.
    const r = allocatePayment(1_150, [
      { interestDue: 300, principalDue: 700 },
      { interestDue: 280, principalDue: 720 },
    ]);
    expect(r.interest).toBeCloseTo(300 + 150, 2);
    expect(r.principal).toBeCloseTo(700, 2);
    expect(r.overpayment).toBe(0);
  });

  it("treats a zero-amount payment as a no-op", () => {
    const r = allocatePayment(0, [{ interestDue: 100, principalDue: 900 }]);
    expect(r.interest).toBe(0);
    expect(r.principal).toBe(0);
    expect(r.overpayment).toBe(0);
  });

  it("reports which installment each slice landed on", () => {
    const r = allocatePayment(1_500, [
      { interestDue: 300, principalDue: 700 },
      { interestDue: 280, principalDue: 720 },
    ]);
    expect(r.perInstallment).toEqual([
      { index: 0, interest: 300, principal: 700 },
      { index: 1, interest: 280, principal: 220 },
    ]);
  });

  it("omits installments the payment never reached", () => {
    const r = allocatePayment(400, [
      { interestDue: 300, principalDue: 700 },
      { interestDue: 280, principalDue: 720 },
    ]);
    expect(r.perInstallment).toEqual([
      { index: 0, interest: 300, principal: 100 },
    ]);
  });
});

/**
 * The regression that motivated per-installment progress tracking.
 *
 * Without `interestPaid` / `principalPaid`, every call allocates against
 * the same full dues, so the same interest is recognized once per payment.
 */
describe("allocatePayment — against remaining due", () => {
  it("does not re-charge interest already collected on an installment", () => {
    const r = allocatePayment(1_000, [
      { interestDue: 1_000, principalDue: 4_000, interestPaid: 1_000 },
    ]);
    expect(r.interest).toBe(0);
    expect(r.principal).toBe(1_000);
  });

  it("splits five 1,000 partials into 1,000 interest and 4,000 principal", () => {
    const inst = { interestDue: 1_000, principalDue: 4_000 };
    let interestPaid = 0;
    let principalPaid = 0;
    let totalInterest = 0;
    let totalPrincipal = 0;

    for (let i = 0; i < 5; i++) {
      const r = allocatePayment(1_000, [
        { ...inst, interestPaid, principalPaid },
      ]);
      interestPaid += r.interest;
      principalPaid += r.principal;
      totalInterest += r.interest;
      totalPrincipal += r.principal;
      expect(r.overpayment).toBe(0);
    }

    // The whole point: 1,000 of interest income, not 5,000.
    expect(totalInterest).toBe(1_000);
    expect(totalPrincipal).toBe(4_000);
  });

  it("carries a payment across the boundary between two installments", () => {
    const r = allocatePayment(1_500, [
      {
        interestDue: 200,
        principalDue: 800,
        interestPaid: 0,
        principalPaid: 0,
      },
      {
        interestDue: 200,
        principalDue: 800,
        interestPaid: 0,
        principalPaid: 0,
      },
    ]);
    // Installment 1 in full (1,000), then 200 interest + 300 principal on #2.
    expect(r.interest).toBe(400);
    expect(r.principal).toBe(1_100);
    expect(r.perInstallment).toEqual([
      { index: 0, interest: 200, principal: 800 },
      { index: 1, interest: 200, principal: 300 },
    ]);
  });

  it("skips a fully-settled installment and moves to the next", () => {
    const r = allocatePayment(500, [
      {
        interestDue: 200,
        principalDue: 800,
        interestPaid: 200,
        principalPaid: 800,
      },
      { interestDue: 200, principalDue: 800 },
    ]);
    expect(r.perInstallment).toEqual([
      { index: 1, interest: 200, principal: 300 },
    ]);
  });

  it("clamps an over-credited row instead of handing back negative headroom", () => {
    // A repair script or manual edit could leave paid > due. That must not
    // inflate the slice available to the next installment.
    const r = allocatePayment(1_000, [
      { interestDue: 200, principalDue: 800, interestPaid: 500 },
      { interestDue: 200, principalDue: 800 },
    ]);
    expect(r.interest).toBe(200); // 0 from #1 (over-credited), 200 from #2
    expect(r.principal).toBe(800); // all of #1's principal
    expect(r.overpayment).toBe(0);
  });

  it("only calls it overpayment once every installment is settled", () => {
    const r = allocatePayment(1_500, [
      {
        interestDue: 200,
        principalDue: 800,
        interestPaid: 200,
        principalPaid: 800,
      },
      {
        interestDue: 200,
        principalDue: 800,
        interestPaid: 100,
        principalPaid: 0,
      },
    ]);
    // #2 has 100 interest + 800 principal left = 900; the rest is advance.
    expect(r.interest).toBe(100);
    expect(r.principal).toBe(800);
    expect(r.overpayment).toBe(600);
  });
});

describe("loanPaymentEntry — overpayment", () => {
  const DATE = new Date("2026-03-15");

  it("credits the excess to Customer Advances, not Loans Receivable", () => {
    const e = loanPaymentEntry({
      loanId: "L1",
      loanNumber: "LN-2026-000001",
      paymentId: "P1",
      amount: 2_500,
      interestPortion: 400,
      principalPortion: 1_600,
      advancePortion: 500,
      paidOn: DATE,
    });

    const creditTo = (code: string) =>
      e.lines
        .filter((l) => l.accountCode === code)
        .reduce((s, l) => s + l.credit, 0);

    // Loans Receivable must see only the real principal. Folding the
    // overpayment in here is what drove the borrower's receivable negative.
    expect(creditTo(ACCOUNT_CODES.LOANS_RECEIVABLE)).toBe(1_600);
    expect(creditTo(ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe(500);
    expect(creditTo(ACCOUNT_CODES.INTEREST_INCOME)).toBe(400);

    const debits = e.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(debits).toBeCloseTo(2_500, 2);
  });

  it("omits the advance line when there is no overpayment", () => {
    const e = loanPaymentEntry({
      loanId: "L1",
      loanNumber: "LN-2026-000001",
      paymentId: "P1",
      amount: 1_000,
      interestPortion: 200,
      principalPortion: 800,
      paidOn: DATE,
    });
    expect(
      e.lines.some((l) => l.accountCode === ACCOUNT_CODES.CUSTOMER_ADVANCES),
    ).toBe(false);
  });
});

describe("penaltyWaiveEntry", () => {
  it("books a balanced waiver (Dr Fee Income, Cr Loans Receivable)", () => {
    const e = penaltyWaiveEntry({
      waiverId: "W1",
      loanId: "L1",
      loanNumber: "LN-2026-000001",
      waivedAmount: 250,
      waivedOn: new Date("2026-04-01"),
      reason: "Customer in good standing",
    });
    expect(e.source).toBe("PENALTY_WAIVE");
    const debits = e.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(debits).toBeCloseTo(250, 2);
  });
});

describe("lateFeeAccrualEntry", () => {
  it("books an accrual when feeAmount > 0", () => {
    const e = lateFeeAccrualEntry({
      loanNumber: "LN-2026-000001",
      scheduleId: "S1",
      installmentNo: 3,
      feeAmount: 50,
      accruedOn: new Date("2026-04-15"),
      periodKey: "2026-04-15",
    });
    expect(e.source).toBe("LATE_FEE_ACCRUAL");
    const debits = e.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(debits).toBeCloseTo(50, 2);
  });
});

describe("eclProvisionEntry", () => {
  const APRIL = {
    periodStart: new Date("2026-04-01"),
    periodEnd: new Date("2026-04-30"),
  };

  it("books the positive-delta case (provisioning more)", () => {
    const e = eclProvisionEntry({
      ...APRIL,
      postedAt: new Date("2026-04-30"),
      delta: 1_500, // ECL increased by 1,500 since last run
    });
    expect(e).not.toBeNull();
    expect(e!.source).toBe("ECL_PROVISION");
    const debits = e!.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e!.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(debits).toBeCloseTo(1_500, 2);
  });

  it("books the negative-delta case (writing back)", () => {
    const e = eclProvisionEntry({
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-31"),
      postedAt: new Date("2026-05-31"),
      delta: -800, // ECL dropped by 800
    });
    expect(e).not.toBeNull();
    const debits = e!.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e!.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(debits).toBeCloseTo(800, 2);
  });

  it("returns null when the delta is sub-penny (no movement to post)", () => {
    const e = eclProvisionEntry({
      periodStart: new Date("2026-06-01"),
      periodEnd: new Date("2026-06-30"),
      postedAt: new Date("2026-06-30"),
      delta: 0.001,
    });
    expect(e).toBeNull();
  });

  /*
   * The idempotency key. These two assertions are the difference between
   * a guard that fires and one that cannot: the ref has to be a function
   * of the period alone, so that re-cutting a window collides with the
   * entry already posted for it, while a later window does not.
   */
  it("keys the entry on the period, identically for the same window", () => {
    const args = { postedAt: new Date("2026-04-30"), delta: 1_500 };
    const first = eclProvisionEntry({ ...APRIL, ...args });
    // A re-run computes a different delta and posts at a different
    // instant; neither may change the key.
    const second = eclProvisionEntry({
      ...APRIL,
      postedAt: new Date("2026-05-02"),
      delta: 1_900,
    });

    expect(first!.sourceRefType).toBe("EclPeriod");
    expect(first!.sourceRefId).toBe("2026-04-01:2026-04-30");
    expect(second!.sourceRefId).toBe(first!.sourceRefId);
  });

  it("gives a different window a different key", () => {
    const april = eclProvisionEntry({
      ...APRIL,
      postedAt: new Date("2026-04-30"),
      delta: 1_500,
    });
    const may = eclProvisionEntry({
      periodStart: new Date("2026-05-01"),
      periodEnd: new Date("2026-05-31"),
      postedAt: new Date("2026-05-31"),
      delta: 1_500,
    });

    expect(may!.sourceRefId).toBe("2026-05-01:2026-05-31");
    expect(may!.sourceRefId).not.toBe(april!.sourceRefId);
  });
});

describe("contributionEntry — cooperative module", () => {
  it("books 4 lines when the contribution funds all three buckets", () => {
    const e = contributionEntry({
      contributionId: "C1",
      customerName: "Juan Dela Cruz",
      capitalBuildUp: 500,
      mortuaryFund: 100,
      emergencyFund: 50,
      contributedAt: new Date("2026-06-01"),
    });
    expect(e).not.toBeNull();
    expect(e!.source).toBe("COOP_CONTRIBUTION");
    expect(e!.lines).toHaveLength(4); // Cash + 3 fund credits
    const debits = e!.lines.reduce((s, l) => s + l.debit, 0);
    const credits = e!.lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBeCloseTo(credits, 2);
    expect(debits).toBeCloseTo(650, 2);
  });

  it("collapses to fewer lines when some buckets are zero", () => {
    const e = contributionEntry({
      contributionId: "C2",
      customerName: "Juan Dela Cruz",
      capitalBuildUp: 500,
      mortuaryFund: 0,
      emergencyFund: 0,
      contributedAt: new Date("2026-06-01"),
    });
    // buildEntry drops zero-amount lines.
    expect(e).not.toBeNull();
    expect(e!.lines).toHaveLength(2); // Cash + CBU only
  });

  it("returns null when every bucket is zero (nothing to book)", () => {
    const e = contributionEntry({
      contributionId: "C3",
      customerName: "Juan Dela Cruz",
      capitalBuildUp: 0,
      mortuaryFund: 0,
      emergencyFund: 0,
      contributedAt: new Date("2026-06-01"),
    });
    expect(e).toBeNull();
  });
});
