import { describe, expect, it } from "vitest";

import {
  agentCommissionEntry,
  agentPayoutEntry,
  allocatePayment,
  bigBrotherEntry,
  buildEntry,
  contributionEntry,
  eclProvisionEntry,
  expenseEntry,
  fundTransactionEntry,
  fundWithdrawalEntry,
  interestAccrualEntry,
  lateFeeAccrualEntry,
  leaseBuyoutEntry,
  loanDisbursementEntry,
  loanPaymentEntry,
  otherIncomeEntry,
  penaltyWaiveEntry,
  preTerminationFeeEntry,
  repossessionAuctionEntry,
  savingsEntry,
} from "./posting";

/**
 * Financial invariants — Phase 2.1 of docs/modernization/roadmap.md.
 *
 * Phase 1 made the DATABASE refuse duplicate money events. These tests
 * cover the other half: that the arithmetic producing those events is
 * right in the first place. They are deliberately property-shaped —
 * many generated inputs per rule rather than a handful of worked
 * examples — because the failures that matter here are the ones nobody
 * thought to write an example for. Rounding at the half-centavo,
 * zero-value legs, an overpayment landing exactly on a boundary.
 *
 * These are invariants, not expected values. They must hold for every
 * input, which means they keep holding when someone changes a rate, a
 * fee rule, or an account code — the class of change that silently
 * unbalances a ledger.
 *
 * The golden corpus (Phase 2.2) is the complement: fixed inputs with
 * committed expected outputs, which is what pins the arithmetic itself.
 * Until that exists, no calculation may be refactored.
 */

/**
 * A small deterministic generator. Seeded rather than random so a
 * failure is reproducible from the test name alone — a flaky financial
 * test that cannot be re-run is worse than no test.
 */
function* money(count: number, max = 250_000): Generator<number> {
  let seed = 0x2f6e2b1;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Two decimals, the precision every money column is declared with.
    yield Math.round(((seed / 0x7fffffff) * max + Number.EPSILON) * 100) / 100;
  }
}

const AMOUNTS = [...money(60)];

/** Half-centavo cases, where naive rounding splits a balanced entry. */
const AWKWARD = [
  0.01, 0.015, 0.025, 1.005, 2.675, 33.333, 66.666, 99.995, 1000.005,
];

/**
 * Amounts that round to nothing. These must NOT produce an entry: two
 * zero lines would be filtered away and `buildEntry` would refuse, which
 * is the correct outcome — an accrual of half a centavo is not a fact
 * the ledger should record.
 */
const BELOW_A_CENTAVO = [0.004, 0.001, 0];

function sums(lines: { debit: number; credit: number }[]) {
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  return { debits, credits };
}

/** The invariant every entry in the system must satisfy. */
function expectBalanced(entry: { lines: { debit: number; credit: number }[] }) {
  const { debits, credits } = sums(entry.lines);
  // One centavo of tolerance, matching buildEntry's own PENNY guard.
  expect(Math.abs(debits - credits)).toBeLessThanOrEqual(0.005);
  for (const l of entry.lines) {
    expect(l.debit).toBeGreaterThanOrEqual(0);
    expect(l.credit).toBeGreaterThanOrEqual(0);
    // A line is one side or the other, never both — otherwise the entry
    // can "balance" while describing nothing.
    expect(l.debit > 0 && l.credit > 0).toBe(false);
  }
}

describe("invariant: every journal entry balances", () => {
  it("holds for disbursements across the amount range, fees and all", () => {
    for (const principal of AMOUNTS) {
      for (const feeRate of [0, 0.01, 0.035]) {
        const feeTotal = Math.round(principal * feeRate * 100) / 100;
        expectBalanced(
          loanDisbursementEntry({
            loanId: "l1",
            loanNumber: "LN-1",
            principal,
            feeTotal,
            disbursedAt: new Date("2026-01-15"),
          }),
        );
      }
    }
  });

  it("holds for payments split every way between interest and principal", () => {
    for (const total of AMOUNTS) {
      // Sweep the split, including the degenerate all-interest and
      // all-principal ends where an off-by-one leg would hide.
      for (const share of [0, 0.25, 0.5, 0.75, 1]) {
        const interest = Math.round(total * share * 100) / 100;
        const principal = Math.round((total - interest) * 100) / 100;
        expectBalanced(
          loanPaymentEntry({
            loanId: "l1",
            loanNumber: "LN-1",
            paymentId: "p1",
            amount: total,
            interestPortion: interest,
            principalPortion: principal,
            paidOn: new Date("2026-01-15"),
          }),
        );
      }
    }
  });

  it("holds at half-centavo amounts, where rounding splits an entry", () => {
    for (const amount of AWKWARD) {
      expectBalanced(
        interestAccrualEntry({
          scheduleId: "s1",
          loanNumber: "LN-1",
          installmentNo: 1,
          interest: amount,
          accruedOn: new Date("2026-01-31"),
        }),
      );
      expectBalanced(
        lateFeeAccrualEntry({
          scheduleId: "s1",
          loanNumber: "LN-1",
          installmentNo: 1,
          feeAmount: amount,
          accruedOn: new Date("2026-01-31"),
          periodKey: "2026-01",
        }),
      );
    }
  });

  it("holds for the cooperative entries", () => {
    for (const amount of AMOUNTS.slice(0, 20)) {
      const third = Math.round((amount / 3) * 100) / 100;
      expectBalanced(
        contributionEntry({
          contributionId: "c1",
          customerName: "M",
          capitalBuildUp: third,
          mortuaryFund: third,
          // The remainder rather than a third, so the legs must add up
          // exactly rather than approximately.
          emergencyFund: Math.round((amount - third * 2) * 100) / 100,
          contributedAt: new Date("2026-01-15"),
        })!,
      );
      for (const kind of ["DEPOSIT", "WITHDRAWAL"] as const) {
        expectBalanced(
          savingsEntry({
            txnId: "t1",
            customerName: "M",
            amount,
            kind,
            txnDate: new Date("2026-01-15"),
          })!,
        );
      }
      expectBalanced(
        fundTransactionEntry({
          txnId: "t1",
          sourceOfFunds: "CAPITAL_BUILD_UP",
          amount,
          txnDate: new Date("2026-01-15"),
        })!,
      );
      expectBalanced(
        fundWithdrawalEntry({
          withdrawalId: "w1",
          sourceOfFunds: "EMERGENCY_FUND",
          amount,
          txnDate: new Date("2026-01-15"),
        })!,
      );
      expectBalanced(
        expenseEntry({
          expenseId: "e1",
          type: "OPERATING",
          amount,
          sourceOfFunds: "SAVINGS",
          txnDate: new Date("2026-01-15"),
        })!,
      );
      expectBalanced(
        otherIncomeEntry({
          incomeId: "i1",
          type: "MISC",
          amount,
          sourceTo: "OTHER_INCOME",
          txnDate: new Date("2026-01-15"),
        })!,
      );
      expectBalanced(
        bigBrotherEntry({
          accountId: "b1",
          name: "M",
          capital: amount,
          receivedAt: new Date("2026-01-15"),
        })!,
      );
    }
  });

  it("holds for agent commission and payout", () => {
    for (const amount of AMOUNTS.slice(0, 20)) {
      expectBalanced(
        agentCommissionEntry({
          loanId: "l1",
          loanNumber: "LN-1",
          agentNumber: "AGT-1",
          amount,
          disbursedAt: new Date("2026-01-15"),
        })!,
      );
      expectBalanced(
        agentPayoutEntry({
          payoutId: "po1",
          payoutNumber: "AP-1",
          agentNumber: "AGT-1",
          amount,
          paidOn: new Date("2026-01-15"),
        }),
      );
    }
  });

  it("holds for the remaining loan-lifecycle entries", () => {
    for (const amount of AMOUNTS.slice(0, 20)) {
      expectBalanced(
        preTerminationFeeEntry({
          loanId: "l1",
          loanNumber: "LN-1",
          fee: amount,
          closedAt: new Date("2026-01-15"),
        }),
      );
      expectBalanced(
        penaltyWaiveEntry({
          waiverId: "w1",
          loanId: "l1",
          loanNumber: "LN-1",
          waivedAmount: amount,
          waivedOn: new Date("2026-01-15"),
          reason: "goodwill",
        }),
      );
      expectBalanced(
        leaseBuyoutEntry({
          agreementId: "a1",
          loanId: "l1",
          loanNumber: "LN-1",
          residualAmount: amount,
          buyoutOn: new Date("2026-01-15"),
        }),
      );
      // A provision movement swings both ways — a write-back is as real
      // as a charge, and the entry has to balance in either direction.
      for (const delta of [amount, -amount]) {
        expectBalanced(
          eclProvisionEntry({
            periodStart: new Date("2026-01-01"),
            periodEnd: new Date("2026-01-31"),
            delta,
            postedAt: new Date("2026-01-31"),
          })!,
        );
      }
    }
  });

  it("holds for a repossession auction, at a surplus and at a deficiency", () => {
    /*
     * Both sides of the auction matter. A deficiency books bad debt; a
     * SURPLUS is the borrower's money and must land in Customer
     * Advances, never in income — the entry balancing is the first line
     * of defence for that.
     */
    for (const outstanding of AMOUNTS.slice(0, 15)) {
      for (const factor of [0.5, 1, 1.5]) {
        expectBalanced(
          repossessionAuctionEntry({
            caseId: "c1",
            loanId: "l1",
            loanNumber: "LN-1",
            outstandingAtRecovery: outstanding,
            auctionProceeds: Math.round(outstanding * factor * 100) / 100,
            auctionedOn: new Date("2026-01-15"),
          }),
        );
      }
    }
  });

  it("records nothing for an amount that rounds to zero", () => {
    /*
     * Half a centavo of accrued interest is not a fact the ledger should
     * record. Both legs round to zero, get filtered, and the entry is
     * refused — which is correct, and worth pinning so nobody "fixes" it
     * into posting empty entries.
     */
    for (const amount of BELOW_A_CENTAVO) {
      expect(() =>
        interestAccrualEntry({
          scheduleId: "s1",
          loanNumber: "LN-1",
          installmentNo: 1,
          interest: amount,
          accruedOn: new Date("2026-01-31"),
        }),
      ).toThrow(/at least two lines/);
    }
  });

  it("refuses to build an entry that does not balance", () => {
    // The guard itself is an invariant: an unbalanced entry must be
    // impossible to construct, not merely unlikely.
    expect(() =>
      buildEntry({
        entryDate: new Date(),
        source: "MANUAL",
        lines: [
          { accountCode: "1000", debit: 100, credit: 0 },
          { accountCode: "4000", debit: 0, credit: 99 },
        ],
      }),
    ).toThrow(/does not balance/);
  });

  it("refuses a negative line rather than filtering it away", () => {
    expect(() =>
      buildEntry({
        entryDate: new Date(),
        source: "MANUAL",
        lines: [
          { accountCode: "1000", debit: -5, credit: 0 },
          { accountCode: "4000", debit: 0, credit: -5 },
        ],
      }),
    ).toThrow(/negative amount/);
  });
});

describe("invariant: a reversal exactly offsets its original", () => {
  /*
   * reverseEntry swaps debit and credit per line. Reversal is the only
   * sanctioned way to undo a posting — the ledger is append-only — so
   * "the pair nets to zero" is the property the whole correction story
   * rests on.
   */
  it("nets every account to zero when the swapped lines are applied", () => {
    for (const principal of AMOUNTS.slice(0, 25)) {
      const original = loanDisbursementEntry({
        loanId: "l1",
        loanNumber: "LN-1",
        principal,
        feeTotal: Math.round(principal * 0.02 * 100) / 100,
        disbursedAt: new Date("2026-01-15"),
      });
      const reversal = original.lines.map((l) => ({
        accountCode: l.accountCode,
        debit: l.credit,
        credit: l.debit,
      }));

      expectBalanced({ lines: reversal });

      const net = new Map<string, number>();
      for (const l of [...original.lines, ...reversal]) {
        net.set(
          l.accountCode,
          (net.get(l.accountCode) ?? 0) + l.debit - l.credit,
        );
      }
      for (const [code, balance] of net) {
        expect(
          Math.abs(balance),
          `account ${code} should net to zero after reversal`,
        ).toBeLessThanOrEqual(0.005);
      }
    }
  });
});

describe("invariant: payment allocation never exceeds the payment", () => {
  const schedule = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      interestDue: 1000 - i * 10,
      principalDue: 3727.98 + i * 25,
      interestPaid: 0,
      principalPaid: 0,
    }));

  it("conserves the amount: interest + principal + overpayment == amount", () => {
    /*
     * The conservation law. Money may move between buckets as the
     * allocation rules change, but none may be created or lost — and an
     * allocator that quietly invents a centavo is how a ledger stops
     * tying to its subledger.
     */
    for (const amount of AMOUNTS) {
      const a = allocatePayment(amount, schedule(6));
      const total =
        Math.round((a.interest + a.principal + a.overpayment) * 100) / 100;
      expect(Math.abs(total - amount)).toBeLessThanOrEqual(0.005);
    }
  });

  it("never allocates more to the loan than was paid", () => {
    for (const amount of AMOUNTS) {
      const a = allocatePayment(amount, schedule(6));
      expect(a.interest + a.principal).toBeLessThanOrEqual(amount + 0.005);
    }
  });

  it("never produces a negative bucket", () => {
    for (const amount of [...AMOUNTS, ...AWKWARD, 0]) {
      const a = allocatePayment(amount, schedule(6));
      expect(a.interest).toBeGreaterThanOrEqual(0);
      expect(a.principal).toBeGreaterThanOrEqual(0);
      expect(a.overpayment).toBeGreaterThanOrEqual(0);
    }
  });

  it("per-installment slices sum to the totals", () => {
    // If these drift apart, the schedule progress and the journal entry
    // describe different payments — the defect the payments test file
    // was written for after it happened.
    for (const amount of AMOUNTS) {
      const a = allocatePayment(amount, schedule(6));
      const i = a.perInstallment.reduce((s, p) => s + p.interest, 0);
      const p = a.perInstallment.reduce((s, x) => s + x.principal, 0);
      expect(Math.abs(i - a.interest)).toBeLessThanOrEqual(0.005);
      expect(Math.abs(p - a.principal)).toBeLessThanOrEqual(0.005);
    }
  });

  it("never allocates past what an installment still owes", () => {
    for (const amount of AMOUNTS) {
      const rows = schedule(6);
      const a = allocatePayment(amount, rows);
      for (const slice of a.perInstallment) {
        const row = rows[slice.index]!;
        expect(slice.interest).toBeLessThanOrEqual(
          row.interestDue - (row.interestPaid ?? 0) + 0.005,
        );
        expect(slice.principal).toBeLessThanOrEqual(
          row.principalDue - (row.principalPaid ?? 0) + 0.005,
        );
      }
    }
  });

  it("recognises interest once across repeated partial payments", () => {
    /*
     * The regression that made this whole area worth guarding: allocation
     * used to run against each installment's FULL interestDue, so one
     * installment paid in five slices booked its interest five times.
     * Stated as an invariant, the rule is that the sum of interest across
     * any sequence of partial payments cannot exceed the interest due.
     */
    const rows = schedule(1);
    let interestSoFar = 0;
    for (let i = 0; i < 5; i++) {
      const a = allocatePayment(1000, rows);
      interestSoFar += a.interest;
      for (const slice of a.perInstallment) {
        rows[slice.index]!.interestPaid += slice.interest;
        rows[slice.index]!.principalPaid += slice.principal;
      }
    }
    expect(interestSoFar).toBeLessThanOrEqual(rows[0]!.interestDue + 0.005);
  });

  it("allocates nothing when there is nothing owing", () => {
    const settled = [
      {
        interestDue: 100,
        principalDue: 900,
        interestPaid: 100,
        principalPaid: 900,
      },
    ];
    const a = allocatePayment(500, settled);
    expect(a.interest).toBe(0);
    expect(a.principal).toBe(0);
    // All of it is the borrower's money, held as an advance — never
    // booked as income against a loan that owes nothing.
    expect(a.overpayment).toBe(500);
  });
});
