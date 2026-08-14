/**
 * Affordability — §16's disposable-income arithmetic, and the DTI the
 * rules are allowed to reason about.
 *
 *     Disposable Income = Net Salary
 *                       + Qualifying Income
 *                       − Existing Obligations
 *                       − Payroll Deductions
 *
 * Before this, nothing on the server computed a DTI at all. The only
 * debt-to-income figure in the product was a client-side hint in the
 * new-loan wizard — `instalment / monthlyIncome` against a 50% ceiling,
 * rendered as advice and never sent anywhere. The engine's view of the
 * borrower's other debts was `existingActiveLoans`: a COUNT. A member
 * ₱2.15M into the coop across four loans and a member ₱40,000 into it
 * across four loans arrived at the rules as the same number, 4.
 *
 * ─── Why this takes plain numbers ───────────────────────────────────
 *
 * Every input is a monthly peso figure the caller has already resolved.
 * This module does not know what a loan is, does not fetch anything and
 * does not decide anything — it is arithmetic that can be read against
 * §16 line by line. The mapping from a borrower's book to
 * `existingObligations` is the caller's job, and it is deliberately not
 * hidden in here: getting that mapping wrong is the interesting failure,
 * and it should be visible at the call site rather than buried under a
 * formula that looks obviously correct.
 *
 * ─── On double-counting ─────────────────────────────────────────────
 *
 * `existingObligations` and `payrollDeductions` are subtracted
 * separately because §16 lists them separately, and a lender that
 * deducts loan amortizations at source could plausibly report the same
 * peso in both. They are NOT reconciled here — this module cannot see
 * the overlap. The caller must pass figures that do not intersect, and
 * `@loan/api`'s context builder documents which side each amount lands
 * on.
 */

export interface AffordabilityInput {
  /** Take-home pay, monthly. */
  netSalary: number;
  /**
   * Other income the lender is willing to underwrite against —
   * commissions, remittances, a spouse's contribution. Separate from
   * salary because §16 separates them, and because a lender may haircut
   * one and not the other before it gets here.
   */
  qualifyingIncome: number;
  /**
   * Monthly repayments on debt the borrower ALREADY holds. This is the
   * figure consolidated exposure exists to supply; passing 0 here is
   * what the engine effectively did before, and it is the reason a
   * fifth loan could be underwritten on the strength of the fourth.
   */
  existingObligations: number;
  /**
   * Non-debt deductions taken before the borrower sees the money —
   * SSS, PhilHealth, Pag-IBIG, union dues, coop capital build-up.
   * Not debt, so they do not enter the DTI ratio, but they do reduce
   * what is actually available to service one.
   */
  payrollDeductions: number;
  /**
   * The monthly amortization of the loan being applied for. Zero for a
   * pure "where do they stand today" reading.
   */
  newLoanInstallment: number;
}

export interface Affordability {
  /** `netSalary + qualifyingIncome`. */
  totalIncome: number;
  existingObligations: number;
  payrollDeductions: number;
  newLoanInstallment: number;
  /**
   * §16 exactly: income less existing obligations less payroll
   * deductions. Deliberately BEFORE the new loan — this is what the
   * borrower has available to service it with, not what is left after.
   */
  disposableIncome: number;
  /** `disposableIncome − newLoanInstallment`. Negative means it does not fit. */
  disposableAfterNewLoan: number;
  /**
   * `(existingObligations + newLoanInstallment) / totalIncome`.
   *
   * Debt only — payroll deductions are not debt and inflating the ratio
   * with them would make every salaried member look more leveraged than
   * they are, against thresholds written for debt.
   *
   * Zero when there is no income to divide by. Not Infinity, and not
   * NaN: both propagate through every numeric comparison in the rule
   * engine as `false`, which silently disables any ceiling written
   * against this field for precisely the applicants who most need one.
   * Zero is wrong in the lenient direction too, but it is a FIGURE — it
   * reads as "no ratio could be computed" on the decision record, and
   * `totalIncome: 0` sits right next to it saying why.
   */
  debtToIncomeRatio: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Coerce anything non-finite to 0 rather than letting NaN spread. */
const num = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * Fold the five figures into §16's disposable income and a DTI.
 *
 * Nothing is floored at zero. A borrower whose obligations already
 * exceed their income has a negative disposable income, and that is the
 * single most useful thing the record can say about them — clamping it
 * would report the most distressed applicant on the book as merely
 * having nothing spare.
 */
export function assessAffordability(input: AffordabilityInput): Affordability {
  const netSalary = num(input.netSalary);
  const qualifyingIncome = num(input.qualifyingIncome);
  const existingObligations = num(input.existingObligations);
  const payrollDeductions = num(input.payrollDeductions);
  const newLoanInstallment = num(input.newLoanInstallment);

  const totalIncome = round2(netSalary + qualifyingIncome);
  const disposableIncome = round2(
    totalIncome - existingObligations - payrollDeductions,
  );

  return {
    totalIncome,
    existingObligations: round2(existingObligations),
    payrollDeductions: round2(payrollDeductions),
    newLoanInstallment: round2(newLoanInstallment),
    disposableIncome,
    disposableAfterNewLoan: round2(disposableIncome - newLoanInstallment),
    debtToIncomeRatio:
      totalIncome > 0
        ? // Four places, not two: a DTI is a ratio in the 0..1 range and
          // rounding it to 0.05 would collide two materially different
          // borrowers onto the same side of a 0.5 ceiling.
          Math.round(
            ((existingObligations + newLoanInstallment) / totalIncome) * 10_000,
          ) / 10_000
        : 0,
  };
}
