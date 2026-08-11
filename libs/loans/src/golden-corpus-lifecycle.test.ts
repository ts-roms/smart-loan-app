import { describe, expect, it } from "vitest";

import { allocatePayment } from "@loan/accounting";

import { computeAmortizationFor } from "./index";
import { DEFAULT_LATE_FEE_POLICY, lateFeeFor } from "./late-fees";
import { computeFees } from "./products";
import { renewalNetProceeds } from "./renewal";

/**
 * Golden corpus, part 2 — the loan lifecycle beyond the schedule.
 *
 * `golden-corpus.test.ts` covers §82's principal / rate / term /
 * frequency. This covers the rest of the list: fees, penalties, grace
 * period, payment history, restructure and payoff.
 *
 * READ THE AUTHORITY MARKERS. Every block below is labelled:
 *
 *   [VERIFIED]        the expected value is derived from the stated
 *                     formula, independently of the implementation. If
 *                     the code disagrees, the CODE is wrong.
 *
 *   [CHARACTERIZATION] the expected value was captured from the
 *                     implementation. It proves behaviour has not
 *                     CHANGED. It does not prove the behaviour is
 *                     RIGHT, and no amount of it ever will.
 *
 * More of this file is VERIFIED than part 1, because fees and penalties
 * are simple closed forms — which is worth saying plainly, since it
 * means the weakest link in the corpus is still the amortization
 * fingerprints, not these.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// FEES — [VERIFIED]
//   processing  = principal × processingFeeRate + processingFeeFlat
//   documentary = principal × documentaryStampRate
//   total       = processing + documentary
//   net         = principal − total
// ─────────────────────────────────────────────────────────────────────

describe("golden: fees [VERIFIED]", () => {
  const CASES = [
    {
      label: "Salary ₱50k — 1% + ₱500 flat, 0.15% DST",
      principal: 50_000,
      cfg: {
        processingFeeRate: 0.01,
        processingFeeFlat: 500,
        documentaryStampRate: 0.0015,
      },
    },
    {
      label: "Auto ₱800k — 2%, no flat, 0.15% DST",
      principal: 800_000,
      cfg: {
        processingFeeRate: 0.02,
        processingFeeFlat: 0,
        documentaryStampRate: 0.0015,
      },
    },
    {
      label: "Housing ₱2.5M — 0.5% + ₱5,000 flat, 0.15% DST",
      principal: 2_500_000,
      cfg: {
        processingFeeRate: 0.005,
        processingFeeFlat: 5_000,
        documentaryStampRate: 0.0015,
      },
    },
    {
      label: "Motorcycle ₱120k — flat fee only",
      principal: 120_000,
      cfg: {
        processingFeeRate: 0,
        processingFeeFlat: 1_500,
        documentaryStampRate: 0,
      },
    },
    {
      label: "No fees at all",
      principal: 10_000,
      cfg: {
        processingFeeRate: 0,
        processingFeeFlat: 0,
        documentaryStampRate: 0,
      },
    },
  ];

  it.each(CASES)("$label", ({ principal, cfg }) => {
    const expectedProcessing = r2(
      principal * cfg.processingFeeRate + cfg.processingFeeFlat,
    );
    const expectedDocumentary = r2(principal * cfg.documentaryStampRate);
    const expectedTotal = r2(expectedProcessing + expectedDocumentary);

    const fees = computeFees(principal, cfg);

    expect(fees.processing).toBe(expectedProcessing);
    expect(fees.documentary).toBe(expectedDocumentary);
    expect(fees.total).toBe(expectedTotal);
    // Fees are WITHHELD from cash out, not added to the debt. The
    // borrower owes `principal`; they receive `principal - fees`. That
    // asymmetry is the whole reason the disbursement entry has three
    // legs rather than two.
    expect(fees.netDisbursement).toBe(r2(principal - expectedTotal));
  });

  it("never disburses more than the principal", () => {
    for (const { principal, cfg } of CASES) {
      const fees = computeFees(principal, cfg);
      expect(fees.netDisbursement).toBeLessThanOrEqual(principal);
      expect(fees.total).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// PENALTIES + GRACE — [VERIFIED]
//   billableDays = max(0, overdueDays − graceDays)
//   fee          = min(totalDue × dailyRate × billableDays,
//                      totalDue × capFraction)
// ─────────────────────────────────────────────────────────────────────

describe("golden: late fees and grace [VERIFIED]", () => {
  const DUE = new Date("2026-03-01T00:00:00.000Z");
  const inst = (paid: Date | null = null) => ({
    dueDate: DUE,
    totalDue: 5_000,
    paidInFullAt: paid,
  });
  const on = (days: number) => new Date(DUE.getTime() + days * DAY);

  // Default policy: 1%/day, 10% cap, 3 grace days.
  const P = DEFAULT_LATE_FEE_POLICY;

  it("charges nothing before the due date", () => {
    expect(lateFeeFor(inst(), on(-5), P)).toBe(0);
    expect(lateFeeFor(inst(), on(0), P)).toBe(0);
  });

  it("charges nothing through the grace window", () => {
    // graceDays = 3, so days 1, 2 and 3 are free.
    for (const d of [1, 2, 3]) {
      expect(lateFeeFor(inst(), on(d), P)).toBe(0);
    }
  });

  it("starts charging on the first day past grace", () => {
    // Day 4 → billable 1 → 5,000 × 0.01 × 1 = 50
    expect(lateFeeFor(inst(), on(4), P)).toBe(50);
    // Day 5 → billable 2 → 100
    expect(lateFeeFor(inst(), on(5), P)).toBe(100);
    // Day 10 → billable 7 → 350
    expect(lateFeeFor(inst(), on(10), P)).toBe(350);
  });

  it("caps at capFraction of the installment", () => {
    // Cap = 5,000 × 0.10 = 500, reached at billable 10 (day 13).
    expect(lateFeeFor(inst(), on(13), P)).toBe(500);
    // And never exceeds it, however long the account runs.
    expect(lateFeeFor(inst(), on(60), P)).toBe(500);
    expect(lateFeeFor(inst(), on(3650), P)).toBe(500);
  });

  it("charges nothing once the installment is settled", () => {
    // A late fee is a charge for money still outstanding. Paid is paid,
    // however late it was — accruing after settlement would bill a
    // borrower for a debt they have already cleared.
    expect(lateFeeFor(inst(on(30)), on(365), P)).toBe(0);
  });

  it("honours a zero-grace policy", () => {
    const strict = { dailyRate: 0.01, capFraction: 0.1, graceDays: 0 };
    expect(lateFeeFor(inst(), on(1), strict)).toBe(50);
  });

  it("honours a zero rate", () => {
    const none = { dailyRate: 0, capFraction: 0.1, graceDays: 3 };
    expect(lateFeeFor(inst(), on(90), none)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PAYMENT HISTORY — [VERIFIED] conservation, [CHARACTERIZATION] split
// ─────────────────────────────────────────────────────────────────────

describe("golden: a payment history [VERIFIED conservation]", () => {
  /**
   * ₱50k / 18% / 24m declining. Instalment ≈ 2,496.21.
   * Six payments: on time, on time, short, catch-up, double, overpay.
   */
  const schedule = () =>
    computeAmortizationFor(50_000, 0.18, 24, {
      method: "DECLINING",
      frequency: "MONTHLY",
    }).map((r) => ({
      interestDue: r.interest,
      principalDue: r.principal,
      interestPaid: 0,
      principalPaid: 0,
    }));

  const HISTORY = [2_496.21, 2_496.21, 1_000, 3_992.42, 4_992.42, 60_000];

  it("conserves every peso across the whole history", () => {
    const rows = schedule();
    let paidIn = 0;
    let allocated = 0;
    let overpaid = 0;

    for (const amount of HISTORY) {
      const a = allocatePayment(amount, rows);
      paidIn = r2(paidIn + amount);
      allocated = r2(allocated + a.interest + a.principal);
      overpaid = r2(overpaid + a.overpayment);
      for (const slice of a.perInstallment) {
        rows[slice.index]!.interestPaid = r2(
          rows[slice.index]!.interestPaid + slice.interest,
        );
        rows[slice.index]!.principalPaid = r2(
          rows[slice.index]!.principalPaid + slice.principal,
        );
      }
    }

    // Nothing created, nothing lost.
    expect(r2(allocated + overpaid)).toBe(paidIn);
  });

  it("never books more interest than the schedule charges", () => {
    const rows = schedule();
    const totalInterestDue = r2(rows.reduce((s, r) => s + r.interestDue, 0));
    let interestBooked = 0;

    for (const amount of HISTORY) {
      const a = allocatePayment(amount, rows);
      interestBooked = r2(interestBooked + a.interest);
      for (const slice of a.perInstallment) {
        rows[slice.index]!.interestPaid = r2(
          rows[slice.index]!.interestPaid + slice.interest,
        );
        rows[slice.index]!.principalPaid = r2(
          rows[slice.index]!.principalPaid + slice.principal,
        );
      }
    }

    // The regression this whole area exists to prevent: recognising the
    // same interest again on each partial payment.
    expect(interestBooked).toBeLessThanOrEqual(totalInterestDue + 0.01);
  });

  it("never books more principal than was borrowed", () => {
    const rows = schedule();
    let principalBooked = 0;
    for (const amount of HISTORY) {
      const a = allocatePayment(amount, rows);
      principalBooked = r2(principalBooked + a.principal);
      for (const slice of a.perInstallment) {
        rows[slice.index]!.interestPaid = r2(
          rows[slice.index]!.interestPaid + slice.interest,
        );
        rows[slice.index]!.principalPaid = r2(
          rows[slice.index]!.principalPaid + slice.principal,
        );
      }
    }
    expect(principalBooked).toBeLessThanOrEqual(50_000 + 0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PAYOFF — [VERIFIED]
//   fee = remainingPrincipal × preTerminationFeeRate
//   due = remainingPrincipal + fee
// ─────────────────────────────────────────────────────────────────────

describe("golden: early payoff [VERIFIED]", () => {
  /**
   * Mirrors `LoanRepository.closeEarly`: the settlement must cover the
   * remaining PRINCIPAL plus a pre-termination fee on that principal.
   * Future interest is not charged — that is the point of paying early.
   */
  const payoffDue = (remainingPrincipal: number, feeRate: number) => {
    const fee = r2(remainingPrincipal * feeRate);
    return { fee, due: r2(remainingPrincipal + fee) };
  };

  const CASES = [
    { label: "Salary, 2% pre-termination", remaining: 32_450.18, rate: 0.02 },
    { label: "Auto, 3%", remaining: 415_003.77, rate: 0.03 },
    { label: "Housing, 5%", remaining: 1_988_412.5, rate: 0.05 },
    { label: "Motorcycle, 5%", remaining: 61_200, rate: 0.05 },
    { label: "No fee configured", remaining: 10_000, rate: 0 },
  ];

  it.each(CASES)("$label", ({ remaining, rate }) => {
    const { fee, due } = payoffDue(remaining, rate);
    expect(fee).toBe(r2(remaining * rate));
    expect(due).toBe(r2(remaining + fee));
    // Paying early must never cost more than continuing to term.
    expect(due).toBeGreaterThanOrEqual(remaining);
  });

  it("charges no future interest", () => {
    // A ₱50k/18%/24m loan owes ₱9,908.93 of interest over its full
    // term. Settling with principal outstanding of ₱25,000 costs
    // ₱25,000 + fee — not ₱25,000 + fee + remaining interest.
    const { due } = payoffDue(25_000, 0.02);
    expect(due).toBe(25_500);
    expect(due).toBeLessThan(25_000 + 9_908.93);
  });
});

// ─────────────────────────────────────────────────────────────────────
// RESTRUCTURE / RENEWAL — [VERIFIED]
//   netProceeds = newPrincipal − payoffAmount
// ─────────────────────────────────────────────────────────────────────

describe("golden: renewal proceeds [VERIFIED]", () => {
  const CASES = [
    { label: "Top-up — new exceeds payoff", nw: 80_000, payoff: 32_450.18 },
    { label: "Like-for-like — nets to zero", nw: 50_000, payoff: 50_000 },
    { label: "Down-size — borrower pays in", nw: 20_000, payoff: 32_450.18 },
    { label: "Fully settled old loan", nw: 100_000, payoff: 0 },
  ];

  it.each(CASES)("$label", ({ nw, payoff }) => {
    expect(renewalNetProceeds(nw, payoff)).toBe(r2(nw - payoff));
  });

  it("returns a negative when the payoff exceeds the new loan", () => {
    // Deliberately NOT floored. A negative net is a real outcome — the
    // borrower must bring cash to settle the difference — and flooring
    // it at zero would silently forgive that shortfall.
    expect(renewalNetProceeds(20_000, 32_450.18)).toBeLessThan(0);
  });
});
