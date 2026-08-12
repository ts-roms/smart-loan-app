/**
 * Consolidated exposure across a borrower's whole book.
 *
 * The cases worth holding down are the ones that would let a lender
 * mis-state what it is owed by one person:
 *
 *   • A borrower with no loans reads ₱0.00 and zero loans, not an empty
 *     object the UI has to guess at.
 *   • Several loans of different products sum, and the visible rows add
 *     up to exactly the visible total.
 *   • A RESTRUCTURED original is excluded — its successor is in the same
 *     list, and counting both doubles the debt of every worked-out
 *     borrower.
 *   • A WRITTEN_OFF loan stays out of the total (the loss is already
 *     expensed) but never disappears from the report.
 *   • A CLOSED loan contributes nothing and is not counted as live.
 *   • An APPROVED loan with no schedule falls back to its contracted
 *     principal rather than reporting ₱0 against committed money.
 */

import { describe, expect, it } from "vitest";

import {
  consolidatedExposure,
  loanExposure,
  type ExposureLoanInput,
} from "./exposure";
import { loanBalance } from "./schedule-balance";

/**
 * Build a loan's position from real schedule rows through the real
 * fold, so these tests break if the balance helper's rules ever change
 * — which is the point of exposure reusing it rather than restating it.
 *
 * `overdueCount` rows are dated in the past; the rest are not. The
 * caller passes what has been paid per instalment.
 */
function loan(
  over: Partial<ExposureLoanInput> & {
    loanNumber: string;
    principal: number;
    installments: number;
    paidInstallments?: number;
    overdueInstallments?: number;
  },
): ExposureLoanInput {
  const {
    installments,
    paidInstallments = 0,
    overdueInstallments = 0,
    ...rest
  } = over;
  const principalDue = over.principal / installments;
  const interestDue = principalDue * 0.1;

  const rows = Array.from({ length: installments }, (_, i) => {
    const settled = i < paidInstallments;
    return {
      principalDue,
      interestDue,
      totalDue: principalDue + interestDue,
      principalPaid: settled ? principalDue : 0,
      interestPaid: settled ? interestDue : 0,
      paidInFullAt: settled ? new Date("2026-01-01") : null,
    };
  });

  // Arrears = the unpaid rows already past due. Same fold, narrower
  // input — exactly what the repository hands over.
  const overdueRows = rows
    .filter((r) => !r.paidInFullAt)
    .slice(0, overdueInstallments);

  return {
    loanId: `id-${over.loanNumber}`,
    productCode: "SALARY",
    status: "ACTIVE",
    balance: loanBalance(rows),
    overdue: loanBalance(overdueRows),
    ...rest,
  };
}

describe("consolidatedExposure", () => {
  it("reports zero for a customer with no loans", () => {
    const result = consolidatedExposure([]);

    expect(result.loans).toEqual([]);
    expect(result.total).toEqual({
      principalOutstanding: 0,
      outstanding: 0,
      pastDue: 0,
      activeLoans: 0,
    });
    expect(result.excluded).toEqual({
      loans: 0,
      closedLoans: 0,
      writtenOffLoans: 0,
      writtenOffPrincipal: 0,
    });
  });

  it("carries a single untouched loan straight through", () => {
    const result = consolidatedExposure([
      loan({ loanNumber: "LN-1", principal: 100_000, installments: 10 }),
    ]);

    expect(result.total.principalOutstanding).toBe(100_000);
    // Principal + the 10% interest the fixture schedules on top.
    expect(result.total.outstanding).toBe(110_000);
    expect(result.total.activeLoans).toBe(1);
    expect(result.loans[0]?.counted).toBe(true);
    expect(result.loans[0]?.fromSchedule).toBe(true);
  });

  it("nets payments off, and the rows sum to the total", () => {
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        principal: 100_000,
        installments: 10,
        paidInstallments: 4,
      }),
    ]);

    expect(result.total.principalOutstanding).toBe(60_000);
    expect(result.loans[0]?.principalOutstanding).toBe(60_000);
  });

  /**
   * The brief's worked example: four products, ₱2,150,000 consolidated.
   * None of them repaid, so the principal outstanding equals what was
   * lent — which is the arithmetic an officer would do by hand and the
   * one they will check this panel against.
   */
  it("sums several loans of different products", () => {
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        productCode: "SALARY",
        principal: 100_000,
        installments: 12,
      }),
      loan({
        loanNumber: "LN-2",
        productCode: "AUTO",
        principal: 500_000,
        installments: 36,
      }),
      loan({
        loanNumber: "LN-3",
        productCode: "HOUSING",
        principal: 1_500_000,
        installments: 120,
      }),
      loan({
        loanNumber: "LN-4",
        productCode: "CREDIT_FACILITY",
        principal: 50_000,
        installments: 6,
      }),
    ]);

    expect(result.total.principalOutstanding).toBe(2_150_000);
    expect(result.total.activeLoans).toBe(4);
    expect(result.excluded.loans).toBe(0);

    // The displayed rows must add to the displayed total, or the panel
    // reads as broken arithmetic.
    const summed = result.loans.reduce(
      (acc, l) => acc + l.principalOutstanding,
      0,
    );
    expect(Math.round(summed * 100) / 100).toBe(
      result.total.principalOutstanding,
    );
  });

  it("adds arrears across loans without touching the outstanding total", () => {
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        principal: 120_000,
        installments: 12,
        overdueInstallments: 2,
      }),
      loan({
        loanNumber: "LN-2",
        principal: 60_000,
        installments: 6,
        overdueInstallments: 1,
      }),
    ]);

    // 2 × (10,000 + 1,000) + 1 × (10,000 + 1,000).
    expect(result.total.pastDue).toBe(33_000);
    expect(result.total.principalOutstanding).toBe(180_000);
    expect(result.loans[0]?.overdueInstallments).toBe(2);
    expect(result.loans[1]?.overdueInstallments).toBe(1);
  });

  /**
   * The judgement call, pinned. A written-off loan is out of the total
   * — the receivable was already expensed to Bad Debt, so counting it
   * would book the same loss twice — but it stays in the report,
   * because a write-off vanishing from a borrower's file is how the
   * same borrower gets lent to again.
   */
  it("keeps a written-off loan out of the total but never out of sight", () => {
    const result = consolidatedExposure([
      loan({ loanNumber: "LN-1", principal: 100_000, installments: 10 }),
      loan({
        loanNumber: "LN-2",
        principal: 250_000,
        installments: 24,
        status: "WRITTEN_OFF",
      }),
    ]);

    expect(result.total.principalOutstanding).toBe(100_000);
    expect(result.total.activeLoans).toBe(1);
    expect(result.excluded.writtenOffLoans).toBe(1);
    expect(result.excluded.writtenOffPrincipal).toBe(250_000);
    expect(result.loans).toHaveLength(2);
    expect(result.loans[1]?.counted).toBe(false);
  });

  it("reports what was ACTUALLY written off, not the contracted amount", () => {
    /*
     * The first version of this used `principal`, which is only correct
     * for a loan written off having repaid nothing. A borrower who
     * repaid most of a loan before defaulting had a small amount go to
     * Bad Debt, and reporting the full contract makes them look far
     * worse than they were — safe in direction for a lending decision,
     * and simply a wrong number in a financial system.
     *
     * The dev fixture happens to have written off the full principal, so
     * this could not have been caught by looking at real data.
     */
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        principal: 250_000,
        installments: 24,
        paidInstallments: 20,
        status: "WRITTEN_OFF",
        writeOffAmount: 41_666.67,
      }),
    ]);

    expect(result.excluded.writtenOffPrincipal).toBe(41_666.67);
    expect(result.loans[0]?.writtenOff).toBe(41_666.67);
  });

  it("falls back to the contract only when no amount was recorded", () => {
    // Legacy rows written off before the amount was captured. The
    // fallback overstates, which is why it is a fallback.
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        principal: 250_000,
        installments: 24,
        status: "WRITTEN_OFF",
        writeOffAmount: null,
      }),
    ]);

    expect(result.excluded.writtenOffPrincipal).toBe(250_000);
  });

  it("reports zero written off on a loan that was not", () => {
    const result = consolidatedExposure([
      loan({ loanNumber: "LN-1", principal: 100_000, installments: 10 }),
    ]);

    expect(result.loans[0]?.writtenOff).toBe(0);
    expect(result.excluded.writtenOffPrincipal).toBe(0);
  });

  it("excludes a closed loan from the live count", () => {
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        principal: 80_000,
        installments: 8,
        paidInstallments: 8,
        status: "CLOSED",
      }),
    ]);

    expect(result.total.principalOutstanding).toBe(0);
    expect(result.total.activeLoans).toBe(0);
    expect(result.excluded.closedLoans).toBe(1);
    expect(result.excluded.writtenOffPrincipal).toBe(0);
    // Still listed — a clean repayment history is the best thing an
    // officer can know about an applicant.
    expect(result.loans).toHaveLength(1);
  });

  it("counts a defaulted loan — the borrower stopped paying, not owing", () => {
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        principal: 100_000,
        installments: 10,
        paidInstallments: 2,
        overdueInstallments: 8,
        status: "DEFAULTED",
      }),
    ]);

    expect(result.total.principalOutstanding).toBe(80_000);
    expect(result.total.pastDue).toBe(88_000);
    expect(result.total.activeLoans).toBe(1);
  });

  it("drops a restructured original so its successor isn't double-counted", () => {
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-OLD",
        principal: 200_000,
        installments: 20,
        status: "RESTRUCTURED",
      }),
      loan({ loanNumber: "LN-NEW", principal: 220_000, installments: 24 }),
    ]);

    expect(result.total.principalOutstanding).toBe(220_000);
    expect(result.total.activeLoans).toBe(1);
    expect(result.excluded.loans).toBe(1);
  });

  it("ignores applications that were never granted", () => {
    const result = consolidatedExposure([
      loan({
        loanNumber: "LN-1",
        principal: 500_000,
        installments: 12,
        status: "SUBMITTED",
      }),
      loan({
        loanNumber: "LN-2",
        principal: 500_000,
        installments: 12,
        status: "REJECTED",
      }),
    ]);

    expect(result.total.principalOutstanding).toBe(0);
    expect(result.total.activeLoans).toBe(0);
    expect(result.excluded.loans).toBe(2);
  });
});

describe("loanExposure", () => {
  /**
   * An approved loan has no schedule until disbursement writes one.
   * Reporting ₱0 there would say the lender is not exposed to money it
   * has already committed to hand over.
   */
  it("falls back to contracted principal when there is no schedule", () => {
    const row = loanExposure({
      loanId: "id-1",
      loanNumber: "LN-1",
      productCode: "AUTO",
      status: "APPROVED",
      principal: "500000.00",
      balance: null,
      overdue: null,
    });

    expect(row.principalOutstanding).toBe(500_000);
    expect(row.outstanding).toBe(500_000);
    expect(row.pastDue).toBe(0);
    expect(row.fromSchedule).toBe(false);
    expect(row.counted).toBe(true);
  });

  it("coerces Decimal-as-string principals rather than concatenating", () => {
    const row = loanExposure({
      loanId: "id-1",
      loanNumber: "LN-1",
      productCode: "SALARY",
      status: "APPROVED",
      principal: "1234.567",
      balance: null,
      overdue: null,
    });

    expect(row.principal).toBe(1234.57);
  });
});
