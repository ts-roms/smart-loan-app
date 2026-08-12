import { describe, expect, it } from "vitest";

import { ledgerPositions, type PositionEntryInput } from "./ledger-position";

/**
 * Position invariants — Phase 2.1 of docs/modernization/roadmap.md.
 *
 * `ledger-position.test.ts` covers the worked examples. This file covers
 * the rules that must hold for EVERY sequence of entries, which is what
 * keeps holding after someone adds a new entry kind or changes an
 * allocation rule.
 *
 * The two positions exist because folding them together produced a real
 * error: a borrower who repaid ₱56,735.76 on a ₱50,000 loan came out
 * +₱6,735.76 and was labelled a net depositor, when that figure is the
 * INTEREST they were charged and the coop holds none of it. These
 * invariants are the fence around that.
 */

/** Deterministic amounts — a reproducible failure beats a random one. */
function* money(count: number, max = 50_000): Generator<number> {
  let seed = 0x51f3a7;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    yield Math.round((seed / 0x7fffffff) * max * 100) / 100;
  }
}

const AMOUNTS = [...money(40)];
const last = (r: { owedAfter: number; heldAfter: number }[]) =>
  r[r.length - 1] ?? { owedAfter: 0, heldAfter: 0 };

describe("invariant: neither position can go negative", () => {
  it("holds however much is repaid against a loan", () => {
    /*
     * Overpaying a loan cannot make the debt negative — "you owe
     * −₱4,000" is not a thing, and the surplus belongs in HELD, as the
     * borrower's money.
     */
    for (const principal of AMOUNTS) {
      const obligation = Math.round(principal * 1.15 * 100) / 100;
      for (const factor of [0, 0.5, 1, 1.5, 3]) {
        const entries: PositionEntryInput[] = [
          { kind: "LOAN_DISBURSEMENT", amount: principal, loanNumber: "LN-1" },
          {
            kind: "LOAN_PAYMENT",
            amount: Math.round(obligation * factor * 100) / 100,
            loanNumber: "LN-1",
          },
        ];
        const result = ledgerPositions(entries, { "LN-1": obligation });
        for (const row of result) {
          expect(row.owedAfter).toBeGreaterThanOrEqual(0);
          expect(row.heldAfter).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("holds when savings are withdrawn beyond the balance", () => {
    for (const amount of AMOUNTS) {
      const result = ledgerPositions([
        { kind: "SAVINGS_DEPOSIT", amount },
        { kind: "SAVINGS_WITHDRAWAL", amount: amount * 3 },
      ]);
      for (const row of result) {
        expect(row.heldAfter).toBeGreaterThanOrEqual(0);
        expect(row.owedAfter).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("invariant: repaying a loan never increases what is held", () => {
  it("keeps interest out of HELD", () => {
    /*
     * The original bug, stated as a rule. Paying interest is money
     * leaving the member; it must never read as the coop holding more
     * on their behalf. Only payment BEYOND the obligation may land in
     * HELD, and only the excess.
     */
    for (const principal of AMOUNTS) {
      const obligation = Math.round(principal * 1.15 * 100) / 100;
      const entries: PositionEntryInput[] = [
        { kind: "LOAN_DISBURSEMENT", amount: principal, loanNumber: "LN-1" },
        { kind: "LOAN_PAYMENT", amount: obligation, loanNumber: "LN-1" },
      ];
      const result = ledgerPositions(entries, { "LN-1": obligation });
      // Paid exactly what was owed: nothing owed, nothing held.
      expect(last(result).owedAfter).toBe(0);
      expect(last(result).heldAfter).toBe(0);
    }
  });

  it("moves only the true excess into HELD", () => {
    for (const principal of AMOUNTS.slice(0, 20)) {
      const obligation = Math.round(principal * 1.15 * 100) / 100;
      const excess = 1234.56;
      const result = ledgerPositions(
        [
          { kind: "LOAN_DISBURSEMENT", amount: principal, loanNumber: "LN-1" },
          {
            kind: "LOAN_PAYMENT",
            amount: Math.round((obligation + excess) * 100) / 100,
            loanNumber: "LN-1",
          },
        ],
        { "LN-1": obligation },
      );
      expect(last(result).owedAfter).toBe(0);
      expect(Math.abs(last(result).heldAfter - excess)).toBeLessThanOrEqual(
        0.01,
      );
    }
  });
});

describe("invariant: loans are tracked apart, not netted", () => {
  it("does not let an overpaid loan cancel a defaulted one", () => {
    /*
     * A regression with teeth: summing all loans into one figure and
     * flooring the TOTAL let ₱10,000 overpaid on loan A hide ₱10,000
     * still owed on loan B, and the member read as settled. Each loan
     * floors on its own, so the debt survives.
     */
    const result = ledgerPositions(
      [
        { kind: "LOAN_DISBURSEMENT", amount: 10_000, loanNumber: "LN-A" },
        { kind: "LOAN_DISBURSEMENT", amount: 10_000, loanNumber: "LN-B" },
        { kind: "LOAN_PAYMENT", amount: 25_000, loanNumber: "LN-A" },
      ],
      { "LN-A": 11_500, "LN-B": 11_500 },
    );
    // LN-B is untouched and still owed in full.
    expect(last(result).owedAfter).toBeGreaterThanOrEqual(11_500);
  });

  it("keeps the sum of per-loan debts, not the net of them", () => {
    for (const a of AMOUNTS.slice(0, 15)) {
      const obligation = Math.round(a * 1.15 * 100) / 100;
      const result = ledgerPositions(
        [
          { kind: "LOAN_DISBURSEMENT", amount: a, loanNumber: "LN-A" },
          { kind: "LOAN_DISBURSEMENT", amount: a, loanNumber: "LN-B" },
          // Wildly overpay one of them.
          {
            kind: "LOAN_PAYMENT",
            amount: obligation * 5,
            loanNumber: "LN-A",
          },
        ],
        { "LN-A": obligation, "LN-B": obligation },
      );
      expect(last(result).owedAfter).toBeGreaterThanOrEqual(obligation - 0.01);
    }
  });
});

describe("invariant: every entry yields a position", () => {
  it("returns one result per entry, in order", () => {
    // The statement renders these row-for-row; a dropped or reordered
    // result silently misattributes a balance to the wrong line.
    const entries: PositionEntryInput[] = [
      { kind: "LOAN_DISBURSEMENT", amount: 10_000, loanNumber: "LN-1" },
      { kind: "SAVINGS_DEPOSIT", amount: 500 },
      { kind: "LOAN_PAYMENT", amount: 2_000, loanNumber: "LN-1" },
      { kind: "CONTRIBUTION", amount: 700, refundableAmount: 500 },
      { kind: "SAVINGS_WITHDRAWAL", amount: 100 },
      { kind: "PENALTY_WAIVER", amount: 50, loanNumber: "LN-1" },
    ];
    const result = ledgerPositions(entries, { "LN-1": 11_500 });
    expect(result).toHaveLength(entries.length);
    for (const row of result) {
      expect(Number.isFinite(row.owedAfter)).toBe(true);
      expect(Number.isFinite(row.heldAfter)).toBe(true);
    }
  });

  it("counts only the held portion of a contribution", () => {
    /*
     * ₱700 made of ₱500 capital build-up, ₱100 mortuary and ₱100
     * emergency is ₱500 held. The benefit funds are pooled and spent on
     * claims; counting them as held would repeat the error the split
     * exists to prevent.
     */
    const result = ledgerPositions([
      { kind: "CONTRIBUTION", amount: 700, refundableAmount: 500 },
    ]);
    expect(last(result).heldAfter).toBe(500);
  });
});
