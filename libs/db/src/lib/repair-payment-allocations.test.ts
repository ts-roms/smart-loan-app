import { describe, expect, it } from "vitest";

import {
  type AuditJournalEntry,
  type AuditLoanInput,
  auditLoan,
  repairEntryLines,
} from "./repair-payment-allocations";

/**
 * Tests for the historical-data auditor.
 *
 * The scenarios below are the ones the old allocation actually produced, so
 * each `posted` split here is what the buggy code would have written — not a
 * hypothetical. The auditor's job is to notice the gap and quantify it.
 */

const INTEREST = "4000";
const RECEIVABLE = "1100";
const ADVANCES = "2100";
const FEE_INCOME = "4100";

function paymentEntry(
  paymentId: string,
  split: { interest?: number; principal?: number; advance?: number },
  entryDate = new Date("2026-04-01"),
): AuditJournalEntry {
  const lines = [
    { accountCode: INTEREST, debit: 0, credit: split.interest ?? 0 },
    { accountCode: RECEIVABLE, debit: 0, credit: split.principal ?? 0 },
    { accountCode: ADVANCES, debit: 0, credit: split.advance ?? 0 },
  ].filter((l) => l.credit > 0);
  return {
    id: `je-${paymentId}`,
    entryDate,
    source: "LOAN_PAYMENT",
    sourceRefType: "LoanPayment",
    sourceRefId: paymentId,
    lines,
  };
}

/** One installment: 1,000 interest + 4,000 principal. */
function loanWithFivePartials(): AuditLoanInput {
  return {
    id: "loan-1",
    number: "LN-2026-000001",
    status: "ACTIVE",
    schedule: [
      {
        id: "sched-1",
        installmentNo: 1,
        principalDue: 4_000,
        interestDue: 1_000,
        principalPaid: 0,
        interestPaid: 0,
        paidInFullAt: null,
      },
    ],
    payments: Array.from({ length: 5 }, (_, i) => ({
      id: `pay-${i + 1}`,
      amount: 1_000,
      paidOn: new Date(2026, 3, i + 1),
      reference: null,
    })),
    // The old code booked all 1,000 as interest, every single time.
    entries: Array.from({ length: 5 }, (_, i) =>
      paymentEntry(`pay-${i + 1}`, { interest: 1_000 }),
    ),
  };
}

describe("auditLoan — repeated partials", () => {
  it("quantifies the over-recognized interest and the missing principal", () => {
    const audit = auditLoan(loanWithFivePartials());

    expect(audit.clean).toBe(false);
    // Posted 5,000 of interest; should have been 1,000.
    expect(audit.delta.interest).toBe(-4_000);
    // Posted no principal; should have been 4,000.
    expect(audit.delta.principal).toBe(4_000);
    expect(audit.delta.advance).toBe(0);
  });

  it("rebuilds the installment's true progress and settlement date", () => {
    const audit = auditLoan(loanWithFivePartials());
    const row = audit.schedule[0]!;

    expect(row.interestPaid).toBe(1_000);
    expect(row.principalPaid).toBe(4_000);
    expect(row.paidInFullAt).toEqual(new Date(2026, 3, 5));
    expect(row.changed).toBe(true);
  });

  it("flags the loan as one that should have closed", () => {
    expect(auditLoan(loanWithFivePartials()).shouldClose).toBe(true);
  });

  it("produces a balanced correcting entry", () => {
    const lines = repairEntryLines(auditLoan(loanWithFivePartials()))!;
    expect(lines).toEqual([
      // Over-recognized income comes back out...
      {
        accountCode: INTEREST,
        debit: 4_000,
        credit: 0,
        memo: expect.any(String),
      },
      // ...and lands against the receivable it should have reduced.
      {
        accountCode: RECEIVABLE,
        debit: 0,
        credit: 4_000,
        memo: expect.any(String),
      },
    ]);
    const debits = lines.reduce((s, l) => s + l.debit, 0);
    const credits = lines.reduce((s, l) => s + l.credit, 0);
    expect(debits).toBe(credits);
  });
});

describe("auditLoan — a loan already repaired", () => {
  /**
   * A repair posts a separate correcting entry rather than rewriting the
   * original payment entries, so the raw diff against those entries still
   * shows the old misstatement. The auditor has to net out the correction,
   * or every re-run reports the same loan as broken and an operator can't
   * tell "already fixed" from "still needs fixing".
   */
  function repaired(): AuditLoanInput {
    const loan = loanWithFivePartials();
    // Schedule progress was written by the repair too.
    loan.status = "CLOSED";
    loan.schedule[0]!.interestPaid = 1_000;
    loan.schedule[0]!.principalPaid = 4_000;
    loan.schedule[0]!.paidInFullAt = new Date(2026, 3, 5);
    loan.entries.push({
      id: "je-repair",
      entryDate: new Date(2026, 4, 1),
      source: "ADJUSTMENT",
      sourceRefType: "LoanPaymentAllocationRepair",
      sourceRefId: loan.id,
      lines: [
        { accountCode: INTEREST, debit: 4_000, credit: 0 },
        { accountCode: RECEIVABLE, debit: 0, credit: 4_000 },
      ],
    });
    return loan;
  }

  it("reports nothing left to do", () => {
    const audit = auditLoan(repaired());
    expect(audit.delta).toEqual({ interest: 0, principal: 0, advance: 0 });
    expect(audit.shouldClose).toBe(false);
    expect(audit.clean).toBe(true);
    expect(repairEntryLines(audit)).toBeNull();
  });

  it("would not double-correct if run again", () => {
    // Belt and braces: even a second correcting entry (which postIfAbsent
    // prevents) must not flip the sign and start over-correcting.
    const loan = repaired();
    const audit = auditLoan(loan);
    expect(Math.abs(audit.delta.interest)).toBeLessThanOrEqual(0.005);
  });
});

describe("auditLoan — correctly-paid loans", () => {
  it("leaves a loan alone when the ledger and schedule already agree", () => {
    const audit = auditLoan({
      id: "loan-2",
      number: "LN-2026-000002",
      status: "CLOSED",
      schedule: [
        {
          id: "sched-1",
          installmentNo: 1,
          principalDue: 800,
          interestDue: 200,
          principalPaid: 800,
          interestPaid: 200,
          paidInFullAt: new Date(2026, 3, 1),
        },
      ],
      payments: [
        {
          id: "pay-1",
          amount: 1_000,
          paidOn: new Date(2026, 3, 1),
          reference: null,
        },
      ],
      entries: [paymentEntry("pay-1", { interest: 200, principal: 800 })],
    });

    expect(audit.clean).toBe(true);
    expect(audit.delta).toEqual({ interest: 0, principal: 0, advance: 0 });
    expect(audit.schedule.every((r) => !r.changed)).toBe(true);
    expect(repairEntryLines(audit)).toBeNull();
  });
});

describe("auditLoan — overpayment", () => {
  it("reclassifies the excess out of Loans Receivable into advances", () => {
    const audit = auditLoan({
      id: "loan-3",
      number: "LN-2026-000003",
      status: "CLOSED",
      schedule: [
        {
          id: "sched-1",
          installmentNo: 1,
          principalDue: 800,
          interestDue: 200,
          principalPaid: 800,
          interestPaid: 0,
          paidInFullAt: new Date(2026, 3, 1),
        },
      ],
      payments: [
        {
          id: "pay-1",
          amount: 1_500,
          paidOn: new Date(2026, 3, 1),
          reference: null,
        },
      ],
      // Old behaviour: principal + overpayment credited together to 1100.
      entries: [paymentEntry("pay-1", { interest: 200, principal: 1_300 })],
    });

    expect(audit.delta.interest).toBe(0);
    expect(audit.delta.principal).toBe(-500);
    expect(audit.delta.advance).toBe(500);

    const lines = repairEntryLines(audit)!;
    expect(lines).toEqual([
      {
        accountCode: RECEIVABLE,
        debit: 500,
        credit: 0,
        memo: expect.any(String),
      },
      {
        accountCode: ADVANCES,
        debit: 0,
        credit: 500,
        memo: expect.any(String),
      },
    ]);
  });
});

describe("auditLoan — late fees charged after settlement", () => {
  it("totals the fees accrued once the installment was really paid", () => {
    const loan = loanWithFivePartials();
    // Replay settles the installment on 2026-04-05. Two accruals after that
    // date were charged against an installment the borrower had cleared.
    loan.entries.push(
      {
        id: "je-fee-1",
        entryDate: new Date(2026, 3, 3),
        source: "LATE_FEE_ACCRUAL",
        sourceRefType: "LoanScheduleLateFee",
        sourceRefId: "sched-1:2026-04-03",
        lines: [{ accountCode: FEE_INCOME, debit: 0, credit: 50 }],
      },
      {
        id: "je-fee-2",
        entryDate: new Date(2026, 3, 10),
        source: "LATE_FEE_ACCRUAL",
        sourceRefType: "LoanScheduleLateFee",
        sourceRefId: "sched-1:2026-04-10",
        lines: [{ accountCode: FEE_INCOME, debit: 0, credit: 50 }],
      },
      {
        id: "je-fee-3",
        entryDate: new Date(2026, 3, 11),
        source: "LATE_FEE_ACCRUAL",
        sourceRefType: "LoanScheduleLateFee",
        sourceRefId: "sched-1:2026-04-11",
        lines: [{ accountCode: FEE_INCOME, debit: 0, credit: 50 }],
      },
    );

    const audit = auditLoan(loan);
    // Only the two after 04-05 count; the 04-03 one was legitimately overdue.
    expect(audit.lateFeeOverAccrued).toBe(100);
  });
});

describe("auditLoan — loans it refuses to touch", () => {
  it.each([
    ["WRITTEN_OFF", "written off"],
    ["RESTRUCTURED", "restructured"],
  ])("skips a %s loan", (status, reason) => {
    const audit = auditLoan({
      ...loanWithFivePartials(),
      status,
      forceSettledBy: reason,
    });
    expect(audit.skipReason).toContain(reason);
    expect(audit.schedule).toEqual([]);
    expect(repairEntryLines(audit)).toBeNull();
  });

  it("skips a loan settled early, which posts its own allocation", () => {
    const loan = loanWithFivePartials();
    loan.payments.push({
      id: "pay-6",
      amount: 500,
      paidOn: new Date(2026, 3, 6),
      reference: "EARLY_SETTLEMENT",
    });
    expect(auditLoan(loan).skipReason).toContain("EARLY_SETTLEMENT");
  });
});

describe("auditLoan — payments that were never posted", () => {
  it("reports them separately instead of folding them into the correction", () => {
    const loan = loanWithFivePartials();
    loan.entries = []; // e.g. the period was closed when the payment landed

    const audit = auditLoan(loan);
    expect(audit.payments.every((p) => p.posted === null)).toBe(true);
    expect(audit.unpostedPaymentIds).toHaveLength(5);
    expect(audit.clean).toBe(false);

    // An unposted payment is missing its cash leg as well, so it can't be
    // fixed by an allocation adjustment. Rolling it in would emit an entry
    // that doesn't balance.
    expect(audit.delta).toEqual({ interest: 0, principal: 0, advance: 0 });
    expect(repairEntryLines(audit)).toBeNull();
  });

  it("still corrects the posted payments alongside an unposted one", () => {
    const loan = loanWithFivePartials();
    loan.entries = loan.entries.slice(0, 4); // pay-5 never posted

    const audit = auditLoan(loan);
    expect(audit.unpostedPaymentIds).toEqual(["pay-5"]);
    // Four payments posted 4,000 of interest; they should have carried
    // 1,000 interest + 3,000 principal.
    expect(audit.delta.interest).toBe(-3_000);
    expect(audit.delta.principal).toBe(3_000);

    const lines = repairEntryLines(audit)!;
    expect(lines.reduce((s, l) => s + l.debit, 0)).toBe(
      lines.reduce((s, l) => s + l.credit, 0),
    );
  });
});
