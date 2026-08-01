import { describe, expect, it } from "vitest";

import {
  computeAmortization,
  computeAmortizationFor,
  installmentCount,
  monthlyPayment,
  periodsPerYear,
} from "./index";
import {
  DEFAULT_LATE_FEE_POLICY,
  lateFeeFor,
  policyFromProduct,
} from "./late-fees";
import { allocatePayment } from "@loan/accounting";
import { computeFees, validateLoanApplication } from "./products";

/**
 * Amortization tests. The schedules these produce drive the live ledger
 * (each schedule row becomes a posting), so they're the highest-leverage
 * place to have property-style coverage:
 *   - principal portions sum back to the original
 *   - balance closes at exactly zero
 *   - FLAT interest matches the closed-form `P × r × N`
 *   - frequency math (monthly / bi-weekly / weekly) is consistent
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Ledger-reconciliation invariants, swept across the whole supported
 * parameter space rather than one hand-picked loan.
 *
 * These exist because the schedule rows are persisted verbatim to
 * `LoanSchedule` and the loan is booked to Loans Receivable at full
 * principal on disbursement. If the rounded rows don't sum back to
 * `principal`, paying every installment leaves a residual receivable that
 * never clears; if `totalDue != principalDue + interestDue`, the two code
 * paths in `recordPayment` (which compares against `totalDue`) and
 * `allocatePayment` (which reads the split) disagree.
 *
 * A single-case assertion missed this for DECLINING: it drifted on ~70% of
 * schedules, by up to ~1 peso on weekly terms, while FLAT was always
 * correct.
 */
describe("schedule reconciliation (property sweep)", () => {
  const principals = [50_000, 12_345.67, 99_999.99, 250_000, 1_000_000];
  const rates = [0, 0.06, 0.12, 0.18, 0.24, 0.36];
  const terms = [3, 6, 12, 24, 36, 60];
  const methods = ["DECLINING", "FLAT"] as const;
  const freqs = ["MONTHLY", "BIWEEKLY", "WEEKLY"] as const;

  for (const method of methods) {
    for (const frequency of freqs) {
      it(`${method}/${frequency}: rows reconcile for every principal × rate × term`, () => {
        for (const principal of principals) {
          for (const annualRate of rates) {
            for (const termMonths of terms) {
              const rows = computeAmortizationFor(
                principal,
                annualRate,
                termMonths,
                { method, frequency },
              );
              const where = `${method}/${frequency} P=${principal} r=${annualRate} t=${termMonths}`;

              // 1. The rounded principal column ties out to the principal.
              const sumPrincipal = round2(
                rows.reduce((s, r) => s + r.principal, 0),
              );
              expect(sumPrincipal, `Σprincipal — ${where}`).toBe(principal);

              // 2. Each row upholds totalDue = principalDue + interestDue,
              //    which is what LoanSchedule.totalDue is documented to be.
              for (const row of rows) {
                expect(
                  row.payment,
                  `row ${row.installmentNo} payment — ${where}`,
                ).toBe(round2(row.principal + row.interest));
              }

              // 3. The loan closes at exactly zero.
              expect(
                rows[rows.length - 1]!.balance,
                `final balance — ${where}`,
              ).toBe(0);
            }
          }
        }
      });
    }
  }
});

describe("monthlyPayment", () => {
  it("matches the closed-form annuity formula for 100k @ 12%/yr over 12 months", () => {
    // Standard PMT: principal=100000, periodRate=0.01 (12%/12), n=12
    // PMT ≈ 8884.88
    expect(monthlyPayment(100_000, 0.01, 12)).toBeCloseTo(8884.88, 2);
  });

  it("falls back to plain division when the rate is zero", () => {
    expect(monthlyPayment(12_000, 0, 12)).toBe(1_000);
  });
});

describe("computeAmortization (declining balance)", () => {
  const principal = 100_000;
  const periodRate = 0.02;
  const n = 24;
  const rows = computeAmortization(principal, periodRate, n);

  it("produces exactly N installments", () => {
    expect(rows).toHaveLength(n);
  });

  it("closes the balance at exactly zero on the final installment", () => {
    expect(rows[rows.length - 1]!.balance).toBe(0);
  });

  // Exact, not `toBeCloseTo(principal, 1)`. That form allows ±0.05, which
  // is far too loose for a figure that has to tie out against Loans
  // Receivable — it let a real rounding drift sit here undetected.
  it("sums principal portions back to the original principal exactly", () => {
    const sumPrincipal = round2(rows.reduce((s, r) => s + r.principal, 0));
    expect(sumPrincipal).toBe(principal);
  });

  it("total paid = principal + interest paid, exactly", () => {
    const totalInterest = round2(rows.reduce((s, r) => s + r.interest, 0));
    const totalPaid = round2(rows.reduce((s, r) => s + r.payment, 0));
    expect(totalPaid).toBe(round2(principal + totalInterest));
  });

  it("every payment except the last is equal to the closed-form PMT (±1 cent)", () => {
    const pmt = monthlyPayment(principal, periodRate, n);
    for (let i = 0; i < n - 1; i++) {
      expect(rows[i]!.payment).toBeCloseTo(pmt, 1);
    }
  });
});

describe("computeAmortization (FLAT / add-on)", () => {
  const principal = 50_000;
  const periodRate = 0.02;
  const n = 12;
  const rows = computeAmortization(principal, periodRate, n, {
    method: "FLAT",
  });

  it("total interest equals principal × periodRate × periodCount (closed form)", () => {
    const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
    expect(totalInterest).toBeCloseTo(principal * periodRate * n, 1);
  });

  it("principal portions sum to original (final installment absorbs drift)", () => {
    const sumP = rows.reduce((s, r) => s + r.principal, 0);
    expect(sumP).toBeCloseTo(principal, 1);
  });

  it("every interim installment is the same flat amount", () => {
    // P/N principal + (totalInterest/N) interest, equal across non-last rows
    const first = rows[0]!;
    for (let i = 1; i < n - 1; i++) {
      expect(rows[i]!.principal).toBe(first.principal);
      expect(rows[i]!.interest).toBe(first.interest);
    }
  });

  it("closes at zero balance", () => {
    expect(rows[rows.length - 1]!.balance).toBe(0);
  });
});

describe("frequency math", () => {
  it.each([
    ["MONTHLY" as const, 12],
    ["BIWEEKLY" as const, 26],
    ["WEEKLY" as const, 52],
  ])("periodsPerYear(%s) = %i", (freq, expected) => {
    expect(periodsPerYear(freq)).toBe(expected);
  });

  it("installmentCount converts term months to total installments", () => {
    expect(installmentCount(12, "MONTHLY")).toBe(12);
    expect(installmentCount(12, "BIWEEKLY")).toBe(26);
    expect(installmentCount(12, "WEEKLY")).toBe(52);
    expect(installmentCount(24, "BIWEEKLY")).toBe(52);
  });
});

describe("computeAmortizationFor (frequency-aware)", () => {
  it("BIWEEKLY declining: 26 installments over 12 months", () => {
    const rows = computeAmortizationFor(100_000, 0.12, 12, {
      method: "DECLINING",
      frequency: "BIWEEKLY",
    });
    expect(rows).toHaveLength(26);
    expect(rows[rows.length - 1]!.balance).toBe(0);
  });

  it("WEEKLY declining: 52 installments over 12 months, principals sum back", () => {
    const principal = 50_000;
    const rows = computeAmortizationFor(principal, 0.12, 12, {
      method: "DECLINING",
      frequency: "WEEKLY",
    });
    expect(rows).toHaveLength(52);
    const sumP = rows.reduce((s, r) => s + r.principal, 0);
    expect(sumP).toBeCloseTo(principal, 1);
  });

  it("BIWEEKLY FLAT: total interest = principal × annualRate (since 26 periods × annual/26 = annual)", () => {
    const principal = 50_000;
    const annualRate = 0.1;
    const rows = computeAmortizationFor(principal, annualRate, 12, {
      method: "FLAT",
      frequency: "BIWEEKLY",
    });
    const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
    expect(totalInterest).toBeCloseTo(principal * annualRate, 1);
    expect(rows).toHaveLength(26);
  });
});

describe("allocatePayment", () => {
  const installments = [
    { interestDue: 200, principalDue: 800 }, // total 1000
    { interestDue: 180, principalDue: 820 }, // total 1000
  ];

  it("pays exactly one installment: interest then principal", () => {
    const a = allocatePayment(1000, installments);
    expect(a.interest).toBeCloseTo(200, 2);
    expect(a.principal).toBeCloseTo(800, 2);
    expect(a.overpayment).toBe(0);
  });

  it("partial payment fills interest first, then partial principal", () => {
    const a = allocatePayment(500, installments);
    expect(a.interest).toBeCloseTo(200, 2);
    expect(a.principal).toBeCloseTo(300, 2);
    expect(a.overpayment).toBe(0);
  });

  it("overpayment lands in the overpayment bucket", () => {
    const a = allocatePayment(2500, installments);
    // 2 installments fully = interest 200+180=380, principal 800+820=1620 = 2000
    // remainder 500 → overpayment
    expect(a.interest).toBeCloseTo(380, 2);
    expect(a.principal).toBeCloseTo(1620, 2);
    expect(a.overpayment).toBeCloseTo(500, 2);
  });
});

describe("computeFees", () => {
  it("combines rate + flat + documentary into total and net", () => {
    const fees = computeFees(100_000, {
      processingFeeRate: 0.02,
      processingFeeFlat: 500,
      documentaryStampRate: 0.0075,
    });
    expect(fees.processing).toBeCloseTo(2_500, 2); // 2000 + 500
    expect(fees.documentary).toBeCloseTo(750, 2);
    expect(fees.total).toBeCloseTo(3_250, 2);
    expect(fees.netDisbursement).toBeCloseTo(96_750, 2);
  });

  it("zero fees pass through cleanly", () => {
    const fees = computeFees(50_000, {
      processingFeeRate: 0,
      processingFeeFlat: 0,
      documentaryStampRate: 0,
    });
    expect(fees.total).toBe(0);
    expect(fees.netDisbursement).toBe(50_000);
  });
});

describe("lateFeeFor", () => {
  const inst = (overdueDays: number) => {
    const due = new Date();
    due.setDate(due.getDate() - overdueDays);
    return { dueDate: due, totalDue: 1000, paidInFullAt: null };
  };

  it("charges zero within the grace window", () => {
    expect(lateFeeFor(inst(2), new Date(), DEFAULT_LATE_FEE_POLICY)).toBe(0);
  });

  it("charges policy.dailyRate per overdue day after grace", () => {
    // grace=3, dailyRate=1%, day 5 = (5-3)*1% of 1000 = 20
    expect(
      lateFeeFor(inst(5), new Date(), DEFAULT_LATE_FEE_POLICY),
    ).toBeCloseTo(20, 2);
  });

  it("honours the cap", () => {
    // Cap=10% of 1000 = 100, even after 365 days overdue
    expect(
      lateFeeFor(inst(365), new Date(), DEFAULT_LATE_FEE_POLICY),
    ).toBeCloseTo(100, 2);
  });

  it("paid installments never accrue fees", () => {
    const paid = { ...inst(30), paidInFullAt: new Date() };
    expect(lateFeeFor(paid, new Date(), DEFAULT_LATE_FEE_POLICY)).toBe(0);
  });

  it("respects a product-supplied custom policy", () => {
    const product = {
      lateFeeDailyRate: 0.005,
      lateFeeCapFraction: 0.2,
      lateFeeGraceDays: 0,
    };
    const policy = policyFromProduct(product);
    // No grace, 10 days × 0.5% × 1000 = 50
    expect(lateFeeFor(inst(10), new Date(), policy)).toBeCloseTo(50, 2);
  });
});

describe("validateLoanApplication", () => {
  const base = {
    code: "SALARY",
    collateralKind: "NONE" as const,
    minPrincipal: 5_000,
    maxPrincipal: 500_000,
    minTermMonths: 3,
    maxTermMonths: 36,
    minRate: 0.12,
    maxRate: 0.36,
    maxLoanToValue: null,
  };

  it("passes a clean application", () => {
    expect(
      validateLoanApplication(base, {
        principal: 50_000,
        termMonths: 12,
        annualInterestRate: 0.18,
      }),
    ).toEqual([]);
  });

  it("flags out-of-range principal/term/rate", () => {
    const issues = validateLoanApplication(base, {
      principal: 1_000_000,
      termMonths: 60,
      annualInterestRate: 0.5,
    });
    expect(issues.map((i) => i.field).sort()).toEqual([
      "annualInterestRate",
      "principal",
      "termMonths",
    ]);
  });

  it("enforces tier-based pricing: tier mapped to null = rejected", () => {
    const issues = validateLoanApplication(
      { ...base, rateByTier: { A: 0.1, F: null } },
      {
        principal: 50_000,
        termMonths: 12,
        annualInterestRate: 0.1,
        tierAtApply: "F",
      },
    );
    expect(issues.some((i) => i.field === "tierAtApply")).toBe(true);
  });

  it("per-tier LTV overrides the flat cap", () => {
    const product = {
      ...base,
      collateralKind: "VEHICLE" as const,
      maxLoanToValue: 0.8,
      ltvByTier: { A: 0.9, C: 0.6 },
    };
    // Tier A can borrow up to 90% of appraised value (90k on 100k collateral)
    expect(
      validateLoanApplication(product, {
        principal: 85_000,
        termMonths: 24,
        annualInterestRate: 0.18,
        collateralAppraisedValue: 100_000,
        tierAtApply: "A",
      }),
    ).toEqual([]);
    // Tier C is capped at 60%; same loan should be rejected
    const cIssues = validateLoanApplication(product, {
      principal: 85_000,
      termMonths: 24,
      annualInterestRate: 0.18,
      collateralAppraisedValue: 100_000,
      tierAtApply: "C",
    });
    expect(cIssues.some((i) => i.field === "principal")).toBe(true);
  });
});
