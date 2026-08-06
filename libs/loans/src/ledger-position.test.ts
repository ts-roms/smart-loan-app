import { describe, expect, it } from "vitest";

import { ledgerPositions, type PositionEntryInput } from "./ledger-position";

const last = <T>(a: T[]) => a[a.length - 1]!;

describe("ledgerPositions", () => {
  /**
   * The case that prompted the split. ₱50,000 disbursed against a
   * ₱56,735.76 schedule, repaid in twelve equal instalments.
   *
   * The old single "net position" ended at +₱6,735.76 and called the
   * borrower a depositor. Both of these must end at zero: he owes
   * nothing and the coop holds nothing for him.
   */
  it("lands a fully-repaid loan on zero owed and zero held", () => {
    const entries: PositionEntryInput[] = [
      { kind: "LOAN_DISBURSEMENT", amount: 50_000, loanNumber: "L1" },
      ...Array.from({ length: 12 }, () => ({
        kind: "LOAN_PAYMENT" as const,
        amount: 4_727.98,
        loanNumber: "L1",
      })),
    ];
    const out = ledgerPositions(entries, { L1: 56_735.76 });
    expect(out[0]!.owedAfter).toBe(56_735.76);
    expect(last(out).owedAfter).toBe(0);
    expect(last(out).heldAfter).toBe(0);
  });

  /**
   * Seeding from the cash instead of the obligation is the specific
   * bug this guards: the total would end NEGATIVE by exactly the
   * interest, which is where "net depositor" came from.
   */
  it("owes the whole obligation from disbursement, not the cash", () => {
    const cashOnly = ledgerPositions(
      [
        { kind: "LOAN_DISBURSEMENT", amount: 50_000, loanNumber: "L1" },
        { kind: "LOAN_PAYMENT", amount: 56_735.76, loanNumber: "L1" },
      ],
      // No obligation supplied → falls back to cash, and the floor is
      // what stops it going negative.
      {},
    );
    expect(last(cashOnly).owedAfter).toBe(0);

    const withSchedule = ledgerPositions(
      [
        { kind: "LOAN_DISBURSEMENT", amount: 50_000, loanNumber: "L1" },
        { kind: "LOAN_PAYMENT", amount: 20_000, loanNumber: "L1" },
      ],
      { L1: 56_735.76 },
    );
    // Halfway through, the honest answer is 36,735.76 — not 30,000.
    expect(last(withSchedule).owedAfter).toBe(36_735.76);
  });

  it("keeps the two positions from touching each other", () => {
    const out = ledgerPositions(
      [
        { kind: "LOAN_DISBURSEMENT", amount: 10_000, loanNumber: "L1" },
        { kind: "SAVINGS_DEPOSIT", amount: 10_000 },
      ],
      { L1: 11_000 },
    );
    // A member who saved 10k and borrowed 10k is NOT square: they owe
    // 11,000 and are owed 10,000, and the coop can call one in without
    // releasing the other. One combined number would have said zero.
    expect(last(out)).toEqual({ owedAfter: 11_000, heldAfter: 10_000 });
  });

  it("holds only the refundable slice of a contribution", () => {
    // One row, three funds: ₱500 CBU + ₱100 mortuary + ₱100 emergency.
    // Only the capital build-up comes back to the member; the benefit
    // funds are pooled and spent on claims. Counting the whole ₱700 as
    // held would repeat the very error this split exists to correct.
    const out = ledgerPositions([
      { kind: "CONTRIBUTION", amount: 700, refundableAmount: 500 },
    ]);
    expect(last(out).heldAfter).toBe(500);
  });

  it("holds nothing for a contribution that is all benefit fund", () => {
    const out = ledgerPositions([
      { kind: "CONTRIBUTION", amount: 200, refundableAmount: 0 },
    ]);
    expect(last(out).heldAfter).toBe(0);
  });

  it("reduces what is owed when a penalty is waived", () => {
    const out = ledgerPositions(
      [
        { kind: "LOAN_DISBURSEMENT", amount: 10_000, loanNumber: "L1" },
        { kind: "PENALTY_WAIVER", amount: 250, loanNumber: "L1" },
      ],
      { L1: 11_000 },
    );
    // No money moved, but the debt is smaller.
    expect(last(out).owedAfter).toBe(10_750);
  });

  it("draws savings down on withdrawal", () => {
    const out = ledgerPositions([
      { kind: "SAVINGS_DEPOSIT", amount: 5_000 },
      { kind: "SAVINGS_WITHDRAWAL", amount: 2_000 },
    ]);
    expect(last(out).heldAfter).toBe(3_000);
  });

  it("never reports a negative position", () => {
    // Overpayment, and a withdrawal beyond the balance. Neither should
    // print as a negative — "you owe −₱200" reads as the lender owing
    // the member money they don't.
    const over = ledgerPositions(
      [
        { kind: "LOAN_DISBURSEMENT", amount: 1_000, loanNumber: "L1" },
        { kind: "LOAN_PAYMENT", amount: 1_200, loanNumber: "L1" },
      ],
      { L1: 1_000 },
    );
    expect(last(over).owedAfter).toBe(0);

    const drained = ledgerPositions([
      { kind: "SAVINGS_DEPOSIT", amount: 100 },
      { kind: "SAVINGS_WITHDRAWAL", amount: 500 },
    ]);
    expect(last(drained).heldAfter).toBe(0);
  });

  it("tracks two loans at once", () => {
    const out = ledgerPositions(
      [
        { kind: "LOAN_DISBURSEMENT", amount: 10_000, loanNumber: "L1" },
        { kind: "LOAN_DISBURSEMENT", amount: 20_000, loanNumber: "L2" },
        { kind: "LOAN_PAYMENT", amount: 5_000, loanNumber: "L1" },
      ],
      { L1: 11_000, L2: 22_000 },
    );
    expect(last(out).owedAfter).toBe(28_000);
  });

  it("returns one result per entry, in order", () => {
    const entries: PositionEntryInput[] = [
      { kind: "SAVINGS_DEPOSIT", amount: 1 },
      { kind: "SAVINGS_DEPOSIT", amount: 2 },
      { kind: "SAVINGS_DEPOSIT", amount: 3 },
    ];
    expect(ledgerPositions(entries).map((r) => r.heldAfter)).toEqual([1, 3, 6]);
  });
});
