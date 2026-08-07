import { describe, expect, it } from "vitest";

import {
  assertPayoutBalances,
  buildPayout,
  NothingPayableError,
  PayoutMismatchError,
  selectPayable,
  type PayableLoan,
} from "./agent-payout";

const POSTED = new Date("2026-08-01T00:00:00Z");

const loan = (
  loanNumber: string,
  commissionAmount: number | null,
  opts: { posted?: boolean; paidBy?: string | null } = {},
): PayableLoan => ({
  loanId: `id-${loanNumber}`,
  loanNumber,
  commissionAmount,
  commissionPostedAt: opts.posted === false ? null : POSTED,
  paidByPayoutId: opts.paidBy ?? null,
});

describe("selectPayable", () => {
  /**
   * The distinction the whole module exists for. "Earned" over a career
   * is PAYABLE + PAID; handing that number to a cashier would pay every
   * commission the agent has ever made, all over again.
   */
  it("separates what is owed now from what has already been paid", () => {
    const out = selectPayable([
      loan("L1", 1_000),
      loan("L2", 2_000, { paidBy: "payout-1" }),
      loan("L3", 500),
    ]);
    expect(out.payable.map((l) => l.loanNumber)).toEqual(["L1", "L3"]);
    expect(out.payableTotal).toBe(1_500);
    expect(out.paidTotal).toBe(2_000);
  });

  /**
   * Paying on assignment would hand over cash for a loan that may still
   * be declined — and would leave the payment with no payable to settle,
   * driving account 2500 negative.
   */
  it("will not pay a commission that has not been booked", () => {
    const out = selectPayable([
      loan("PIPELINE", 5_000, { posted: false }),
      loan("FUNDED", 1_000),
    ]);
    expect(out.payable.map((l) => l.loanNumber)).toEqual(["FUNDED"]);
    expect(out.payableTotal).toBe(1_000);
  });

  it("leaves zero-commission loans off the sheet entirely", () => {
    // Not listed at ₱0.00: a line that moves no money is a line an
    // approver has to read and dismiss.
    const out = selectPayable([
      loan("Z1", 0),
      loan("Z2", null),
      loan("P", 100),
    ]);
    expect(out.payable).toHaveLength(1);
    expect(out.payableTotal).toBe(100);
  });

  it("reports zeroes for an agent with nothing outstanding", () => {
    expect(selectPayable([])).toEqual({
      payable: [],
      payableTotal: 0,
      paidTotal: 0,
    });
  });

  it("rounds the totals rather than the rows", () => {
    const out = selectPayable([loan("A", 0.1), loan("B", 0.2)]);
    expect(out.payableTotal).toBe(0.3);
  });
});

describe("buildPayout", () => {
  const book = [
    loan("L1", 1_000),
    loan("L2", 2_500),
    loan("L3", 400, { paidBy: "payout-1" }),
    loan("L4", 800, { posted: false }),
  ];

  it("builds lines for the chosen loans and totals them", () => {
    const draft = buildPayout(book, ["id-L1", "id-L2"]);
    expect(draft.total).toBe(3_500);
    expect(draft.items).toEqual([
      { loanId: "id-L1", amount: 1_000 },
      { loanId: "id-L2", amount: 2_500 },
    ]);
  });

  it("pays a duplicated id once", () => {
    const draft = buildPayout(book, ["id-L1", "id-L1"]);
    expect(draft.items).toHaveLength(1);
    expect(draft.total).toBe(1_000);
  });

  /**
   * Refused, not skipped. Silently dropping an unpayable id produces a
   * payout smaller than the cashier was told to hand over, and the
   * difference goes unnoticed until the agent complains.
   */
  it("refuses a loan that has already been paid", () => {
    expect(() => buildPayout(book, ["id-L1", "id-L3"])).toThrow(
      NothingPayableError,
    );
  });

  it("refuses a loan that has not been disbursed", () => {
    expect(() => buildPayout(book, ["id-L4"])).toThrow(NothingPayableError);
  });

  it("refuses a loan belonging to somebody else", () => {
    expect(() => buildPayout(book, ["id-SOMEONE-ELSE"])).toThrow(
      NothingPayableError,
    );
  });

  it("says which loan was rejected and why", () => {
    // The cashier has to be able to fix the selection without guessing.
    try {
      buildPayout(book, ["id-L3", "id-L4"]);
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("L3 (already paid)");
      expect(msg).toContain("L4 (not disbursed)");
    }
  });

  it("refuses an empty selection", () => {
    expect(() => buildPayout(book, [])).toThrow(NothingPayableError);
  });
});

describe("assertPayoutBalances", () => {
  const draft = { items: [{ loanId: "a", amount: 1_234.56 }], total: 1_234.56 };

  it("accepts a total that matches its lines", () => {
    expect(() => assertPayoutBalances(1_234.56, draft)).not.toThrow();
  });

  it("tolerates float dust but not a real difference", () => {
    expect(() => assertPayoutBalances(1_234.5601, draft)).not.toThrow();
    // One centavo is a real difference: it would leave a remainder in
    // account 2500 that nobody is looking for.
    expect(() => assertPayoutBalances(1_234.55, draft)).toThrow(
      PayoutMismatchError,
    );
  });

  it("names both figures so the gap is visible", () => {
    try {
      assertPayoutBalances(1_000, draft);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("1000.00");
      expect((e as Error).message).toContain("1234.56");
    }
  });
});
