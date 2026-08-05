/**
 * Balance arithmetic over a persisted schedule.
 *
 * The cases worth holding down are the ones a borrower would notice:
 *
 *   • A fully-settled loan reads ₱0.00, never "-₱0.00" — float dust on a
 *     dozen two-decimal sums otherwise shows a negative balance, which
 *     reads as an error in the lender's favour.
 *   • Decimals arriving as strings (Prisma over the wire) are counted,
 *     not concatenated or dropped.
 *   • The actual balance tracks payments, so a borrower who is ahead
 *     sees it below the contractual line and one who is behind sees it
 *     flatten where they stopped.
 */

import { describe, expect, it } from "vitest";

import {
  balanceFromTotals,
  loanBalance,
  runningBalances,
} from "./schedule-balance";

/** Three instalments of 1,000 principal + 100 interest. */
function schedule(
  paid: Array<{ principal: number; interest: number; settled?: boolean }>,
) {
  return paid.map((p) => ({
    principalDue: 1000,
    interestDue: 100,
    totalDue: 1100,
    principalPaid: p.principal,
    interestPaid: p.interest,
    paidInFullAt: p.settled ? new Date() : null,
  }));
}

describe("loanBalance", () => {
  it("totals an untouched schedule", () => {
    const rows = schedule([
      { principal: 0, interest: 0 },
      { principal: 0, interest: 0 },
      { principal: 0, interest: 0 },
    ]);
    expect(loanBalance(rows)).toMatchObject({
      scheduled: 3300,
      paid: 0,
      outstanding: 3300,
      principalOutstanding: 3000,
      paidInstallments: 0,
      totalInstallments: 3,
    });
  });

  it("nets payments off the outstanding figure", () => {
    const rows = schedule([
      { principal: 1000, interest: 100, settled: true },
      { principal: 400, interest: 0 },
      { principal: 0, interest: 0 },
    ]);
    const balance = loanBalance(rows);
    expect(balance.paid).toBe(1500);
    expect(balance.outstanding).toBe(1800);
    expect(balance.principalOutstanding).toBe(1600);
    // Only the row the repository marked settled counts — a part-paid
    // instalment is not a paid one.
    expect(balance.paidInstallments).toBe(1);
  });

  it("reads zero, not below it, on a fully-paid loan", () => {
    // Decimals that don't sum cleanly in binary floating point — the
    // real shape of the "-₱0.00" bug.
    const rows = [
      {
        principalDue: 333.33,
        interestDue: 0.01,
        totalDue: 333.34,
        principalPaid: 333.33,
        interestPaid: 0.01,
        paidInFullAt: new Date(),
      },
      {
        principalDue: 333.33,
        interestDue: 0.01,
        totalDue: 333.34,
        principalPaid: 333.33,
        interestPaid: 0.01,
        paidInFullAt: new Date(),
      },
      {
        principalDue: 333.34,
        interestDue: 0.01,
        totalDue: 333.35,
        principalPaid: 333.34,
        interestPaid: 0.01,
        paidInFullAt: new Date(),
      },
    ];
    const balance = loanBalance(rows);
    expect(balance.outstanding).toBe(0);
    expect(balance.principalOutstanding).toBe(0);
    expect(Object.is(balance.outstanding, -0)).toBe(false);
  });

  it("coerces the strings Prisma sends for decimal columns", () => {
    const rows = [
      {
        principalDue: "1000.00",
        interestDue: "100.00",
        totalDue: "1100.00",
        principalPaid: "250.00",
        interestPaid: "0.00",
        paidInFullAt: null,
      },
    ];
    const balance = loanBalance(rows);
    expect(balance.scheduled).toBe(1100);
    expect(balance.paid).toBe(250);
    expect(balance.outstanding).toBe(850);
  });

  it("treats an empty schedule as a zeroed position, not NaN", () => {
    // Every pre-disbursement loan hits this — there are no instalments
    // until funds are released.
    expect(loanBalance([])).toMatchObject({
      scheduled: 0,
      paid: 0,
      outstanding: 0,
      totalInstallments: 0,
    });
  });
});

describe("balanceFromTotals", () => {
  it("derives the same position the row fold would", () => {
    // The list endpoints let Postgres sum; this has to agree with
    // loanBalance() or a loan's balance changes depending on whether you
    // looked at the list or the detail page.
    const rows = schedule([
      { principal: 1000, interest: 100, settled: true },
      { principal: 400, interest: 0 },
      { principal: 0, interest: 0 },
    ]);
    const folded = loanBalance(rows);
    const aggregated = balanceFromTotals({
      scheduled: 3300,
      paid: 1500,
      principalScheduled: 3000,
      principalPaid: 1400,
      paidInstallments: 1,
      totalInstallments: 3,
    });
    expect(aggregated).toEqual(folded);
  });

  it("floors an over-paid loan at zero like the row fold does", () => {
    const balance = balanceFromTotals({
      scheduled: 1000,
      paid: 1000.0000001,
      principalScheduled: 900,
      principalPaid: 900.0000001,
      paidInstallments: 1,
      totalInstallments: 1,
    });
    expect(balance.outstanding).toBe(0);
    expect(balance.principalOutstanding).toBe(0);
  });
});

describe("runningBalances", () => {
  it("walks the contractual balance down to zero", () => {
    const rows = schedule([
      { principal: 0, interest: 0 },
      { principal: 0, interest: 0 },
      { principal: 0, interest: 0 },
    ]);
    expect(runningBalances(rows, 3000).map((r) => r.scheduledBalance)).toEqual([
      2000, 1000, 0,
    ]);
  });

  it("puts the actual balance below the contractual one when ahead", () => {
    // Both instalments settled, plus 500 extra principal on the second.
    const rows = [
      {
        principalDue: 1000,
        interestDue: 100,
        totalDue: 1100,
        principalPaid: 1000,
        interestPaid: 100,
        paidInFullAt: new Date(),
      },
      {
        principalDue: 1000,
        interestDue: 100,
        totalDue: 1100,
        principalPaid: 1500,
        interestPaid: 100,
        paidInFullAt: new Date(),
      },
    ];
    const [, second] = runningBalances(rows, 3000);
    expect(second!.scheduledBalance).toBe(1000);
    expect(second!.actualBalance).toBe(500);
  });

  it("flattens the actual balance where payments stopped", () => {
    const rows = schedule([
      { principal: 1000, interest: 100, settled: true },
      { principal: 0, interest: 0 },
      { principal: 0, interest: 0 },
    ]);
    const balances = runningBalances(rows, 3000);
    // Contractual keeps marching down; actual stays at 2000 from the
    // point the borrower stopped paying, which is the whole signal.
    expect(balances.map((b) => b.scheduledBalance)).toEqual([2000, 1000, 0]);
    expect(balances.map((b) => b.actualBalance)).toEqual([2000, 2000, 2000]);
  });

  it("never renders a negative final row", () => {
    const rows = schedule([{ principal: 5000, interest: 100, settled: true }]);
    expect(runningBalances(rows, 1000)[0]!.actualBalance).toBe(0);
  });
});
