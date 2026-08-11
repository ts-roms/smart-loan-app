import { describe, expect, it } from "vitest";

import { ACCOUNT_CODES, DEFAULT_CHART_OF_ACCOUNTS } from "./chart";
import { badDebtRecoveryEntry, loanPaymentEntry } from "./posting";

/**
 * Recovering on a written-off loan is income, not a debt to the
 * borrower.
 *
 * The defect this pins down, found by tracing what a recovery payment
 * actually posts:
 *
 *   1. `writeOff` marks every instalment paid in full and posts
 *      Dr Bad Debt Expense / Cr Loans Receivable. The receivable is
 *      gone and no instalment is open.
 *   2. `PAYABLE_STATUSES` includes WRITTEN_OFF, so a recovery payment
 *      is accepted — correctly; recovery is a real thing that happens.
 *   3. With no open instalment, `allocatePayment` returns 0 interest,
 *      0 principal and the WHOLE amount as overpayment.
 *   4. `loanPaymentEntry` books overpayment to Customer Advances.
 *
 * So a ₱50,000 recovery from a defaulter was recorded as the lender
 * owing that defaulter ₱50,000. Income understated, liabilities
 * overstated, and the borrower shown as a creditor for money the
 * lender had just clawed back — and if anyone ever "refunded" that
 * advance, the lender would pay out its own recovery.
 *
 * The entry balanced, so nothing in the ledger complained.
 */

const sums = (lines: { debit: number; credit: number }[]) => ({
  debits: lines.reduce((s, l) => s + l.debit, 0),
  credits: lines.reduce((s, l) => s + l.credit, 0),
});

const creditTo = (
  lines: { accountCode: string; debit: number; credit: number }[],
  code: string,
) =>
  lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.credit, 0);

describe("badDebtRecoveryEntry", () => {
  const entry = () =>
    badDebtRecoveryEntry({
      loanId: "l1",
      loanNumber: "LN-1",
      paymentId: "p1",
      amount: 50_000,
      paidOn: new Date("2026-06-15"),
    })!;

  it("credits Bad Debt Recovery, not Customer Advances", () => {
    const lines = entry().lines;
    expect(creditTo(lines, ACCOUNT_CODES.BAD_DEBT_RECOVERY)).toBe(50_000);
    // The heart of the bug: this must be zero.
    expect(creditTo(lines, ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe(0);
  });

  it("debits cash for the full amount", () => {
    const lines = entry().lines;
    expect(
      lines
        .filter((l) => l.accountCode === ACCOUNT_CODES.CASH)
        .reduce((s, l) => s + l.debit, 0),
    ).toBe(50_000);
  });

  it("does not touch Loans Receivable", () => {
    // The receivable was already credited to nothing by the write-off.
    // Crediting it again would drive it negative.
    const lines = entry().lines;
    expect(
      lines.some((l) => l.accountCode === ACCOUNT_CODES.LOANS_RECEIVABLE),
    ).toBe(false);
  });

  it("does not reverse the original write-off", () => {
    // The expense belonged to the period the loan was given up on; the
    // recovery belongs to the period the cash arrived. Touching Bad Debt
    // EXPENSE here would restate a closed period.
    const lines = entry().lines;
    expect(
      lines.some((l) => l.accountCode === ACCOUNT_CODES.BAD_DEBT_EXPENSE),
    ).toBe(false);
  });

  it("balances", () => {
    const { debits, credits } = sums(entry().lines);
    expect(debits).toBe(credits);
  });

  it("returns null rather than an empty entry for a zero recovery", () => {
    expect(
      badDebtRecoveryEntry({
        loanId: "l1",
        loanNumber: "LN-1",
        paymentId: "p1",
        amount: 0,
        paidOn: new Date(),
      }),
    ).toBeNull();
  });

  it("rounds to the centavo", () => {
    const e = badDebtRecoveryEntry({
      loanId: "l1",
      loanNumber: "LN-1",
      paymentId: "p1",
      amount: 1_234.567,
      paidOn: new Date(),
    })!;
    expect(creditTo(e.lines, ACCOUNT_CODES.BAD_DEBT_RECOVERY)).toBe(1_234.57);
  });

  it("is tagged for idempotency like every other auto-post", () => {
    const e = entry();
    expect(e.sourceRefType).toBe("LoanPayment");
    expect(e.sourceRefId).toBe("p1");
  });
});

describe("the distinction being drawn", () => {
  it("a genuinely overpaid LIVE loan still credits Customer Advances", () => {
    /*
     * The reason the branch keys on loan STATUS rather than on "no open
     * instalments". A borrower who overpays a live loan really is owed
     * their excess back — that is a liability, and booking it as
     * recovery income would be taking their money.
     */
    const lines = loanPaymentEntry({
      loanId: "l1",
      loanNumber: "LN-1",
      paymentId: "p2",
      amount: 6_000,
      interestPortion: 1_000,
      principalPortion: 4_000,
      advancePortion: 1_000,
      paidOn: new Date("2026-06-15"),
    }).lines;

    expect(creditTo(lines, ACCOUNT_CODES.CUSTOMER_ADVANCES)).toBe(1_000);
    expect(creditTo(lines, ACCOUNT_CODES.BAD_DEBT_RECOVERY)).toBe(0);
  });
});

describe("chart of accounts", () => {
  it("carries Bad Debt Recovery as a system income account", () => {
    const account = DEFAULT_CHART_OF_ACCOUNTS.find(
      (a) => a.code === ACCOUNT_CODES.BAD_DEBT_RECOVERY,
    );
    expect(account).toBeDefined();
    expect(account!.type).toBe("INCOME");
    expect(account!.normalBalance).toBe("CREDIT");
    expect(account!.system).toBe(true);
  });

  it("keeps recovery separate from other income", () => {
    // Folding recoveries into miscellaneous receipts would lose the one
    // ratio that measures a collections function: how much of what was
    // given up on came back.
    expect(ACCOUNT_CODES.BAD_DEBT_RECOVERY).not.toBe(
      ACCOUNT_CODES.OTHER_INCOME,
    );
  });
});
