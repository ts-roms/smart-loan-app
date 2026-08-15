import { describe, expect, it } from "vitest";

import {
  ALLOCATION_ORDERS,
  DEFAULT_ALLOCATION_ORDER,
  type InstallmentDue,
  type PaymentAllocationOrder,
  allocatePayment,
} from "./posting";

/**
 * §26 — configurable allocation order.
 *
 * The golden file next door pins what a loan on the legacy order pays. This
 * one covers what the configurability actually buys: the tiers, the orders,
 * and the two guarantees that make it safe to ship — that the default is
 * the legacy order, and that an order carrying the new tiers cannot move a
 * peso while the balances behind them are zero.
 */

/** Instalment 1 of the golden schedule, with charges layered on. */
const WITH_CHARGES: InstallmentDue = {
  feeDue: 100.0,
  penaltyDue: 250.0,
  interestDue: 750.0,
  principalDue: 8026.26,
};

const ALL_ORDERS = Object.keys(ALLOCATION_ORDERS) as PaymentAllocationOrder[];

describe("the default order is the one every existing loan pays under", () => {
  it("is INTEREST_PRINCIPAL", () => {
    expect(DEFAULT_ALLOCATION_ORDER).toBe("INTEREST_PRINCIPAL");
  });

  it("is what `allocatePayment` uses when the caller says nothing", () => {
    // A caller that has not been taught about §26 must keep getting the
    // behaviour it has always had.
    const implicit = allocatePayment(5_000, [WITH_CHARGES]);
    const explicit = allocatePayment(
      5_000,
      [WITH_CHARGES],
      "INTEREST_PRINCIPAL",
    );
    expect(implicit).toEqual(explicit);
  });

  it("ignores fee and penalty balances entirely", () => {
    // ₱5,000 against a row carrying 100 fee + 250 penalty: the legacy order
    // has no tier for either, so all 5,000 goes to interest then principal.
    const r = allocatePayment(5_000, [WITH_CHARGES], "INTEREST_PRINCIPAL");

    expect(r.interest).toBe(750.0);
    expect(r.principal).toBe(4_250.0);
    expect(r.fees).toBeUndefined();
    expect(r.penalties).toBeUndefined();
    // And the slice is the pre-§26 shape, key for key.
    expect(r.perInstallment).toEqual([
      { index: 0, interest: 750.0, principal: 4_250.0 },
    ]);
  });
});

describe("FEES_PENALTIES_INTEREST_PRINCIPAL — §26's stated default", () => {
  it("takes fees, then penalties, then interest, then principal", () => {
    /*
     * ₱5,000 against 100 fee / 250 penalty / 750 interest / 8,026.26 principal.
     *   fee       100.00 → remaining 4,900.00
     *   penalty   250.00 → remaining 4,650.00
     *   interest  750.00 → remaining 3,900.00
     *   principal 3,900.00 → remaining 0.00
     */
    const r = allocatePayment(
      5_000,
      [WITH_CHARGES],
      "FEES_PENALTIES_INTEREST_PRINCIPAL",
    );

    expect(r.fees).toBe(100.0);
    expect(r.penalties).toBe(250.0);
    expect(r.interest).toBe(750.0);
    expect(r.principal).toBe(3_900.0);
    expect(r.overpayment).toBe(0);
  });

  it("kills 350.00 less principal than the legacy order on the same payment", () => {
    // The borrower-visible consequence of the tiers, stated as a figure.
    // This is the change §26 asks for and the reason existing loans are
    // pinned to their own snapshotted order.
    const legacy = allocatePayment(5_000, [WITH_CHARGES], "INTEREST_PRINCIPAL");
    const s26 = allocatePayment(
      5_000,
      [WITH_CHARGES],
      "FEES_PENALTIES_INTEREST_PRINCIPAL",
    );

    expect(legacy.principal - s26.principal).toBe(350.0);
    expect(s26.principal).toBe(3_900.0);
    expect(legacy.principal).toBe(4_250.0);
  });

  it("reports the tiers on the slice so the caller can persist them", () => {
    const r = allocatePayment(
      5_000,
      [WITH_CHARGES],
      "FEES_PENALTIES_INTEREST_PRINCIPAL",
    );
    expect(r.perInstallment).toEqual([
      {
        index: 0,
        fee: 100.0,
        penalty: 250.0,
        interest: 750.0,
        principal: 3_900.0,
      },
    ]);
  });

  it("stops mid-tier when the money runs out", () => {
    // ₱300: the fee in full, then 200 of the 250 penalty, nothing else.
    const r = allocatePayment(
      300,
      [WITH_CHARGES],
      "FEES_PENALTIES_INTEREST_PRINCIPAL",
    );

    expect(r.fees).toBe(100.0);
    expect(r.penalties).toBe(200.0);
    expect(r.interest).toBe(0);
    expect(r.principal).toBe(0);
    expect(r.perInstallment).toEqual([
      { index: 0, fee: 100.0, penalty: 200.0, interest: 0, principal: 0 },
    ]);
  });

  it("runs against what is still owed, not the original charge", () => {
    // Half the fee and all the penalty already collected.
    const r = allocatePayment(
      1_000,
      [{ ...WITH_CHARGES, feePaid: 60.0, penaltyPaid: 250.0 }],
      "FEES_PENALTIES_INTEREST_PRINCIPAL",
    );

    expect(r.fees).toBe(40.0);
    expect(r.penalties).toBeUndefined();
    expect(r.interest).toBe(750.0);
    expect(r.principal).toBe(210.0);
  });
});

describe("INTEREST_PRINCIPAL_FEES_PENALTIES — charges last", () => {
  it("reduces the debt first and settles charges only after", () => {
    /*
     * ₱9,000 against the same row.
     *   interest    750.00 → 8,250.00
     *   principal 8,026.26 →   223.74
     *   fee         100.00 →   123.74
     *   penalty     123.74 (of 250.00) → 0.00
     */
    const r = allocatePayment(
      9_000,
      [WITH_CHARGES],
      "INTEREST_PRINCIPAL_FEES_PENALTIES",
    );

    expect(r.interest).toBe(750.0);
    expect(r.principal).toBe(8_026.26);
    expect(r.fees).toBe(100.0);
    expect(r.penalties).toBe(123.74);
    expect(r.overpayment).toBe(0);
  });

  it("clears the instalment's principal where §26's order would not", () => {
    const s26 = allocatePayment(
      9_000,
      [WITH_CHARGES],
      "FEES_PENALTIES_INTEREST_PRINCIPAL",
    );
    const friendly = allocatePayment(
      9_000,
      [WITH_CHARGES],
      "INTEREST_PRINCIPAL_FEES_PENALTIES",
    );

    expect(friendly.principal).toBe(8_026.26);
    expect(s26.principal).toBe(7_900.0);
    // Compared in centavos — subtracting the two doubles in the test would
    // land on 126.26000000000022, which is the very thing the allocator
    // stopped doing.
    expect(
      Math.round(friendly.principal * 100) - Math.round(s26.principal * 100),
    ).toBe(12_626);
  });
});

describe("every order conserves the payment", () => {
  it("allocates exactly what was handed over, whatever the order", () => {
    for (const order of ALL_ORDERS) {
      for (const amount of [0.01, 300, 5_000, 9_126.26, 20_000]) {
        const r = allocatePayment(amount, [WITH_CHARGES], order);
        const total =
          (r.fees ?? 0) +
          (r.penalties ?? 0) +
          r.interest +
          r.principal +
          r.overpayment;
        expect(total).toBe(amount);
      }
    }
  });

  it("never allocates a tier more than it was owed", () => {
    const DUE = {
      FEES: 100.0,
      PENALTIES: 250.0,
      INTEREST: 750.0,
      PRINCIPAL: 8_026.26,
    };
    for (const order of ALL_ORDERS) {
      const r = allocatePayment(1_000_000, [WITH_CHARGES], order);
      expect(r.fees ?? 0).toBeLessThanOrEqual(DUE.FEES);
      expect(r.penalties ?? 0).toBeLessThanOrEqual(DUE.PENALTIES);
      expect(r.interest).toBeLessThanOrEqual(DUE.INTEREST);
      expect(r.principal).toBeLessThanOrEqual(DUE.PRINCIPAL);

      /*
       * The rest is the borrower's and comes back as overpayment — but
       * only the tiers this order actually HAS get taken. The legacy order
       * has no fee or penalty tier, so it leaves those 350.00 unclaimed
       * and hands 350.00 more back. That asymmetry is the feature.
       */
      const claimable = ALLOCATION_ORDERS[order].reduce(
        (sum, tier) => sum + DUE[tier],
        0,
      );
      expect(r.overpayment).toBe(1_000_000 - claimable);
    }
  });
});

describe("an instalment with nothing charged on it allocates the same way under every order", () => {
  /*
   * WHAT THIS BLOCK USED TO SAY, AND WHY THE WORDS CHANGED.
   *
   * It was called "the tiers are inert until the balances behind them are
   * real", and it justified itself with: nothing populates a per-instalment
   * fee or penalty balance, so `recordPayment` passes neither, so selecting
   * §26's order cannot move a peso. It ended by predicting that THIS test
   * would be the one to start failing when the balances became real.
   *
   * The balances are real now. `recordPayment` passes `penaltyDue` and
   * `penaltyPaid` for any loan whose order carries the tier, read from the
   * `LATE_FEE_ACCRUAL` ledger and from `LoanSchedule`. So the reason is
   * dead — but the prediction was only half right, and the half it got
   * wrong is worth recording. THESE ASSERTIONS STILL PASS, and correctly
   * so: they hand `allocatePayment` instalments with no charges on them,
   * and an allocator asked to divide money between tiers that are all zero
   * has nothing to do differently. The claim that died was the prose, not
   * the arithmetic.
   *
   * A unit test of a pure function could never have caught the change,
   * because the function never changed. The tests that had to move are the
   * ones that drive `recordPayment`, where the inputs come from somewhere:
   * `loan.repository.allocation-order.test.ts` and
   * `loan.repository.penalty-collection.golden.test.ts`. That is the real
   * lesson here — an alarm wired to a pure function cannot detect a change
   * in what its callers feed it.
   *
   * What survives is the property itself, which is now the safety property
   * rather than a statement about the feature being incomplete: an
   * instalment carrying no fee and no penalty pays identically under every
   * order. Every loan written before §26 is in exactly that position, and
   * most of them will stay there.
   */
  const NO_CHARGES: InstallmentDue[] = [
    { interestDue: 750.0, principalDue: 8026.26 },
    { interestDue: 629.61, principalDue: 8146.65 },
    { interestDue: 507.41, principalDue: 8268.85 },
  ];

  it("gives identical results for all three orders when fees and penalties are zero", () => {
    for (const amount of [0, 5_000, 8_776.26, 20_000, 30_000]) {
      const results = ALL_ORDERS.map((o) =>
        allocatePayment(amount, NO_CHARGES, o),
      );
      for (const r of results) expect(r).toEqual(results[0]);
    }
  });

  it("still does so once a penalty has been fully paid off", () => {
    /*
     * The same property one step further on, and the one that makes the
     * paid-to-date figure load-bearing rather than decorative. An
     * instalment whose 250.00 penalty has been collected has nothing left
     * on that tier, so it must go back to allocating like an unpenalised
     * one. Without `penaltyPaid` the tier would still read 250.00 open and
     * every subsequent payment would collect it again.
     */
    const settled: InstallmentDue[] = NO_CHARGES.map((i, n) =>
      n === 0 ? { ...i, penaltyDue: 250.0, penaltyPaid: 250.0 } : i,
    );
    for (const amount of [0, 5_000, 8_776.26, 20_000, 30_000]) {
      const results = ALL_ORDERS.map((o) =>
        allocatePayment(amount, settled, o),
      );
      for (const r of results) expect(r).toEqual(results[0]);
      expect(results[0]!.penalties).toBeUndefined();
    }
  });

  it("produces literally the pre-§26 object on the legacy order", () => {
    // No `fees`, no `penalties`, no `fee`/`penalty` on the slices — the
    // same keys the function returned before §26 existed.
    const r = allocatePayment(8_776.26, NO_CHARGES, "INTEREST_PRINCIPAL");
    expect(Object.keys(r).sort()).toEqual([
      "interest",
      "overpayment",
      "perInstallment",
      "principal",
    ]);
    expect(Object.keys(r.perInstallment[0]!).sort()).toEqual([
      "index",
      "interest",
      "principal",
    ]);
  });
});

describe("ALLOCATION_ORDERS", () => {
  it("names every order after the tiers it actually applies", () => {
    // The enum value in the database is this key, so a name that disagreed
    // with its own sequence would be a trap for whoever reads a loan row.
    for (const [name, tiers] of Object.entries(ALLOCATION_ORDERS)) {
      expect(tiers.join("_")).toBe(name);
    }
  });

  it("lists each tier at most once per order", () => {
    for (const tiers of Object.values(ALLOCATION_ORDERS)) {
      expect(new Set(tiers).size).toBe(tiers.length);
    }
  });
});
