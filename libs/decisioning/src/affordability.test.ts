import { describe, expect, it } from "vitest";

import { assessAffordability } from "./affordability";

/**
 * §16, line by line:
 *
 *     Disposable Income = Net Salary + Qualifying Income
 *                       − Existing Obligations − Payroll Deductions
 *
 * What makes this worth testing is not the subtraction. It is the three
 * decisions the subtraction encodes:
 *
 *   1. Disposable income is measured BEFORE the new loan, so it reads
 *      as capacity to service it rather than as what survives it.
 *   2. Payroll deductions reduce disposable income but do NOT enter the
 *      DTI ratio — they are not debt.
 *   3. Nothing is clamped. A borrower already underwater comes out
 *      negative, because that is the most useful thing the record can
 *      say about them.
 */

const base = {
  netSalary: 40_000,
  qualifyingIncome: 0,
  existingObligations: 0,
  payrollDeductions: 0,
  newLoanInstallment: 0,
};

describe("assessAffordability — the §16 formula", () => {
  it("subtracts obligations and deductions from combined income", () => {
    const a = assessAffordability({
      netSalary: 40_000,
      qualifyingIncome: 12_000,
      existingObligations: 8_000,
      payrollDeductions: 3_500,
      newLoanInstallment: 0,
    });

    expect(a.totalIncome).toBe(52_000);
    expect(a.disposableIncome).toBe(40_500);
  });

  it("measures disposable income before the new loan, not after", () => {
    /*
     * The distinction an underwriter actually uses: "they have ₱32,000
     * spare, the loan costs ₱4,729" is a decision they can make.
     * "They have ₱27,270 left" hides the comparison inside the number.
     */
    const a = assessAffordability({
      ...base,
      existingObligations: 8_000,
      newLoanInstallment: 4_729.5,
    });

    expect(a.disposableIncome).toBe(32_000);
    expect(a.disposableAfterNewLoan).toBe(27_270.5);
  });

  it("counts both existing and new debt in the ratio", () => {
    // The whole point of §53 reaching DTI: the application in front of
    // the engine is not the borrower's only debt.
    const a = assessAffordability({
      ...base,
      existingObligations: 12_000,
      newLoanInstallment: 8_000,
    });

    expect(a.debtToIncomeRatio).toBe(0.5);
  });

  it("keeps payroll deductions out of the ratio", () => {
    /*
     * SSS, PhilHealth, Pag-IBIG and capital build-up are not debt.
     * Folding them in would make every salaried member read as more
     * leveraged than they are, against thresholds written for debt —
     * i.e. it would decline people for being employed.
     */
    const withDeductions = assessAffordability({
      ...base,
      existingObligations: 10_000,
      payrollDeductions: 6_000,
    });
    const without = assessAffordability({
      ...base,
      existingObligations: 10_000,
    });

    expect(withDeductions.debtToIncomeRatio).toBe(without.debtToIncomeRatio);
    // But they DO reduce what is actually available.
    expect(withDeductions.disposableIncome).toBe(24_000);
    expect(without.disposableIncome).toBe(30_000);
  });
});

describe("assessAffordability — the borrower who is already underwater", () => {
  it("reports a negative disposable income rather than flooring at zero", () => {
    /*
     * Clamping would report the most distressed applicant on the book
     * as merely "having nothing spare", which is the same reading as a
     * borrower who breaks exactly even. They are not the same borrower.
     */
    const a = assessAffordability({
      ...base,
      existingObligations: 62_000,
    });

    expect(a.disposableIncome).toBe(-22_000);
  });

  it("lets the ratio exceed 1", () => {
    const a = assessAffordability({
      ...base,
      existingObligations: 62_000,
      newLoanInstallment: 4_729.5,
    });

    expect(a.debtToIncomeRatio).toBeGreaterThan(1);
  });
});

describe("assessAffordability — no income to divide by", () => {
  it("returns a ratio of zero rather than Infinity or NaN", () => {
    /*
     * Load-bearing. Every numeric comparison in the rule engine is
     * typeof-guarded and then compared: `Infinity > 0.5` is true, but
     * `NaN > 0.5` is false, and a NaN ratio would silently disable any
     * DTI ceiling for exactly the applicants with no recorded income.
     * Zero is lenient too — but it is a FIGURE, and `totalIncome: 0`
     * sits beside it on the decision record explaining why.
     */
    const a = assessAffordability({
      ...base,
      netSalary: 0,
      existingObligations: 5_000,
      newLoanInstallment: 4_000,
    });

    expect(a.debtToIncomeRatio).toBe(0);
    expect(Number.isFinite(a.debtToIncomeRatio)).toBe(true);
    expect(a.totalIncome).toBe(0);
    // The obligations are still visible — only the ratio is undefined.
    expect(a.disposableIncome).toBe(-5_000);
  });

  it("absorbs non-finite inputs instead of propagating them", () => {
    const a = assessAffordability({
      netSalary: Number.NaN,
      qualifyingIncome: Number.POSITIVE_INFINITY,
      existingObligations: Number.NaN,
      payrollDeductions: 0,
      newLoanInstallment: Number.NaN,
    });

    for (const v of Object.values(a)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("assessAffordability — rounding", () => {
  it("rounds money to centavos", () => {
    const a = assessAffordability({
      ...base,
      netSalary: 40_000.005,
      existingObligations: 1_234.567,
    });

    expect(a.existingObligations).toBe(1_234.57);
    expect(Number.isInteger(a.disposableIncome * 100)).toBe(true);
  });

  it("keeps the ratio to four places, not two", () => {
    /*
     * A DTI lives in the 0..1 range. Rounding it to two places puts
     * 0.4951 and 0.5049 on the same value, which is the difference
     * between passing and failing a 50% ceiling.
     */
    const a = assessAffordability({
      ...base,
      netSalary: 43_000,
      existingObligations: 21_300,
    });

    expect(a.debtToIncomeRatio).toBe(0.4953);
  });
});

describe("assessAffordability — what it deliberately does not do", () => {
  it("does not reconcile obligations against payroll deductions", () => {
    /*
     * A coop that deducts loan amortizations at source could report the
     * same ₱8,000 as both an obligation and a deduction. This module
     * cannot see that overlap and does not guess at it — it subtracts
     * what it is given, twice, and the caller is responsible for
     * passing figures that do not intersect.
     *
     * Pinned as a test because the alternative — silently deduping —
     * would be a hidden policy decision about which of the two to drop.
     */
    const a = assessAffordability({
      ...base,
      existingObligations: 8_000,
      payrollDeductions: 8_000,
    });

    expect(a.disposableIncome).toBe(24_000);
  });

  it("makes no decision", () => {
    // No verdict, no flag, no threshold. §50: a human sets the policy;
    // this returns figures for a rule to be written against.
    const a = assessAffordability({ ...base, existingObligations: 90_000 });
    expect(Object.keys(a).sort()).toEqual([
      "debtToIncomeRatio",
      "disposableAfterNewLoan",
      "disposableIncome",
      "existingObligations",
      "newLoanInstallment",
      "payrollDeductions",
      "totalIncome",
    ]);
  });
});
