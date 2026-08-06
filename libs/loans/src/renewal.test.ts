import { describe, expect, it } from "vitest";

import { checkRenewal, renewalNetProceeds } from "./renewal";

const NOW = new Date("2026-08-01T00:00:00Z");
const day = (iso: string) => new Date(iso);

/**
 * A twelve-instalment loan, ₱120,000 principal, ₱1,000 interest each.
 * `paid` marks how many of the instalments have been settled in full.
 */
const schedule = (paid: number, opts?: { lastDueDate?: string }) =>
  Array.from({ length: 12 }, (_, i) => {
    const settled = i < paid;
    return {
      principalDue: 10_000,
      interestDue: 1_000,
      totalDue: 11_000,
      principalPaid: settled ? 10_000 : 0,
      interestPaid: settled ? 1_000 : 0,
      paidInFullAt: settled ? "2026-01-01T00:00:00Z" : null,
      // Unpaid instalments fall in the future unless a test says otherwise.
      dueDate:
        opts?.lastDueDate && i === paid
          ? day(opts.lastDueDate)
          : day(`2026-${String(9 + Math.floor(i / 4)).padStart(2, "0")}-01`),
    };
  });

describe("checkRenewal", () => {
  const base = { minPaidFraction: 0.5, now: NOW };

  it("refuses a loan that isn't live and funded", () => {
    for (const status of ["SUBMITTED", "APPROVED", "CLOSED", "DEFAULTED"]) {
      const r = checkRenewal({ ...base, status, schedule: schedule(6) });
      expect(r.eligible).toBe(false);
      if (!r.eligible) expect(r.reason).toBe("NotRenewableStatus");
    }
  });

  it("allows a loan exactly at the threshold", () => {
    // 6 of 12 instalments = half the principal. The boundary has to be
    // inclusive or a policy of "at least 50%" rejects exactly 50%.
    const r = checkRenewal({
      ...base,
      status: "ACTIVE",
      schedule: schedule(6),
    });
    expect(r.eligible).toBe(true);
  });

  it("refuses one instalment short of it", () => {
    const r = checkRenewal({
      ...base,
      status: "ACTIVE",
      schedule: schedule(5),
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toBe("InsufficientlyPaid");
      expect(r.paidFraction).toBeCloseTo(5 / 12, 5);
      expect(r.requiredFraction).toBe(0.5);
    }
  });

  it("honours a configured threshold rather than a hard-coded half", () => {
    const rows = schedule(4); // a third paid
    expect(
      checkRenewal({
        ...base,
        minPaidFraction: 0.3,
        status: "ACTIVE",
        schedule: rows,
      }).eligible,
    ).toBe(true);
    expect(
      checkRenewal({
        ...base,
        minPaidFraction: 0.8,
        status: "ACTIVE",
        schedule: rows,
      }).eligible,
    ).toBe(false);
  });

  /**
   * The case the ordering exists for: past the threshold AND behind.
   * Paying 75% early then missing instalments must not buy a new loan —
   * lending again to someone currently in default is precisely what
   * this gate is for.
   */
  it("refuses arrears even when the paid-down test passes", () => {
    const rows = schedule(9, { lastDueDate: "2026-07-01" }); // overdue
    const r = checkRenewal({ ...base, status: "ACTIVE", schedule: rows });
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.reason).toBe("InArrears");
      expect(r.overdueInstallments).toBe(1);
    }
  });

  it("refuses a loan already renewed once", () => {
    const r = checkRenewal({
      ...base,
      status: "ACTIVE",
      schedule: schedule(12),
      alreadyRenewed: true,
    });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("AlreadyRenewed");
  });

  /**
   * The payoff is the FULL outstanding, interest included. Netting only
   * principal would leave an interest stub and turn a "renewed" loan
   * into one still open for a few pesos.
   */
  it("quotes the whole outstanding balance as the payoff", () => {
    const r = checkRenewal({
      ...base,
      status: "ACTIVE",
      schedule: schedule(6),
    });
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      // 6 unpaid instalments × ₱11,000 (₱10k principal + ₱1k interest).
      expect(r.payoffAmount).toBe(66_000);
    }
  });

  it("measures progress on principal, not on money paid", () => {
    // Interest-heavy early instalments: ₱1,000 principal, ₱10,000
    // interest. Six of twelve paid is most of the CASH but only half
    // the principal — and a schedule where they diverge is exactly
    // where the wrong measure would quietly pass a bad renewal.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      principalDue: 1_000,
      interestDue: i < 6 ? 10_000 : 0,
      totalDue: i < 6 ? 11_000 : 1_000,
      principalPaid: i < 6 ? 1_000 : 0,
      interestPaid: i < 6 ? 10_000 : 0,
      paidInFullAt: i < 6 ? "2026-01-01T00:00:00Z" : null,
      dueDate: day("2026-12-01"),
    }));
    const r = checkRenewal({ ...base, status: "ACTIVE", schedule: rows });
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.paidFraction).toBeCloseTo(0.5, 5);
  });

  it("treats a loan with no schedule as unpaid rather than fully paid", () => {
    // 0/0 must not read as 100%. Dividing by a zero scheduled principal
    // is how a brand-new loan would otherwise qualify instantly.
    const r = checkRenewal({ ...base, status: "ACTIVE", schedule: [] });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.reason).toBe("InsufficientlyPaid");
  });
});

describe("renewalNetProceeds", () => {
  it("hands over the difference", () => {
    expect(renewalNetProceeds(200_000, 66_000)).toBe(134_000);
  });

  it("reports a shortfall rather than flooring it at zero", () => {
    // A new principal smaller than the old balance means the borrower
    // owes money to complete the renewal. Hiding that behind a zero
    // would show "₱0.00 to release" for a loan that needs a payment.
    expect(renewalNetProceeds(50_000, 66_000)).toBe(-16_000);
  });

  it("rounds to centavos", () => {
    expect(renewalNetProceeds(100_000.005, 0.001)).toBe(100_000);
  });
});
