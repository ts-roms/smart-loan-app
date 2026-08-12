import { describe, expect, it } from "vitest";

import {
  AGING_BUCKETS,
  buildAgingReport,
  OVERDUE_BUCKETS,
  type AgingBucket,
  type ScheduleRowForAging,
} from "./reports";

/**
 * Invariant: the aging report distinguishes a loan that is late from one
 * that is gone.
 *
 * `D_90_PLUS` pooled a loan 95 days overdue with one three years past
 * due. Those are not the same asset — the first is a collections problem
 * with a borrower still reachable, the second is a write-off argument —
 * and they provision at different rates. A single bucket cannot support
 * either decision.
 *
 * The bands are §28's, not invented ones: Current, 1–30, 31–60, 61–90,
 * 91–120, 121–180, 180+.
 *
 * Report-only. Nothing persists a bucket and nothing computes money from
 * one: ECL stages independently on days-past-due, so these bands move no
 * provision and restate no ledger. That is why this could change without
 * a migration or a reconciliation.
 */

const DAY = 86_400_000;
const ASOF = new Date("2026-08-12T00:00:00.000Z");

/** One unpaid instalment, `daysLate` days past due as of ASOF. */
function overdue(
  loanNumber: string,
  daysLate: number,
  totalDue = 1_000,
): ScheduleRowForAging {
  return {
    loanId: loanNumber,
    loanNumber,
    customerName: "Test Borrower",
    installmentNo: 1,
    dueDate: new Date(ASOF.getTime() - daysLate * DAY),
    totalDue,
    paidInFullAt: null,
  };
}

const bucketOf = (daysLate: number): AgingBucket =>
  buildAgingReport([overdue("LN-1", daysLate)], ASOF).rows[0]!.bucket;

describe("the band boundaries", () => {
  it("puts a loan that is not yet due in CURRENT", () => {
    expect(bucketOf(0)).toBe("CURRENT");
    expect(bucketOf(-5)).toBe("CURRENT");
  });

  it("walks the seven bands", () => {
    expect(bucketOf(1)).toBe("D_1_30");
    expect(bucketOf(45)).toBe("D_31_60");
    expect(bucketOf(75)).toBe("D_61_90");
    expect(bucketOf(100)).toBe("D_91_120");
    expect(bucketOf(150)).toBe("D_121_180");
    expect(bucketOf(400)).toBe("D_180_PLUS");
  });

  it("treats each upper bound as inclusive", () => {
    /*
     * The off-by-one that matters most is 90. "Ninety days past due" is
     * read as the 90th day NOT having crossed the line, so 90 stays in
     * D_61_90 and 91 is the first non-performing day. Getting this
     * backwards would move loans across the performing boundary a day
     * early, in the direction that flatters the book.
     */
    expect(bucketOf(30)).toBe("D_1_30");
    expect(bucketOf(31)).toBe("D_31_60");
    expect(bucketOf(60)).toBe("D_31_60");
    expect(bucketOf(61)).toBe("D_61_90");
    expect(bucketOf(90)).toBe("D_61_90");
    expect(bucketOf(91)).toBe("D_91_120");
    expect(bucketOf(120)).toBe("D_91_120");
    expect(bucketOf(121)).toBe("D_121_180");
    expect(bucketOf(180)).toBe("D_121_180");
    expect(bucketOf(181)).toBe("D_180_PLUS");
  });

  it("separates the two loans the old report could not tell apart", () => {
    // The whole reason for the change, stated as an assertion.
    expect(bucketOf(95)).not.toBe(bucketOf(3 * 365));
  });
});

describe("the totals", () => {
  it("carry every band, including the empty ones", () => {
    /*
     * A band absent from `totals` renders as blank rather than as zero,
     * and a blank row reads as "no data" — which on a delinquency report
     * is the opposite of "nothing is this late".
     */
    const report = buildAgingReport([overdue("LN-1", 10)], ASOF);

    for (const b of AGING_BUCKETS) {
      expect(report.totals[b], b).toBeTypeOf("number");
    }
  });

  it("sum to the outstanding balance", () => {
    const report = buildAgingReport(
      [
        overdue("LN-1", 0, 1_000),
        overdue("LN-2", 45, 2_000),
        overdue("LN-3", 100, 3_000),
        overdue("LN-4", 500, 4_000),
      ],
      ASOF,
    );

    const summed = AGING_BUCKETS.reduce((a, b) => a + report.totals[b], 0);
    expect(summed).toBeCloseTo(report.totalOutstanding, 2);
    expect(report.totalOutstanding).toBe(10_000);
  });

  it("put each loan in exactly one band", () => {
    const report = buildAgingReport(
      [overdue("LN-1", 45, 2_000), overdue("LN-2", 400, 5_000)],
      ASOF,
    );

    expect(report.totals.D_31_60).toBe(2_000);
    expect(report.totals.D_180_PLUS).toBe(5_000);
    expect(report.totals.D_91_120).toBe(0);
  });
});

describe("portfolio at risk", () => {
  it("is every band except CURRENT", () => {
    /*
     * Derived rather than listed, and asserted here because the derived
     * version is the fix for a specific failure: a hand-kept list of
     * overdue bands leaves a newly added band rendering in the table
     * while quietly dropping out of the PAR figure above it.
     */
    expect(OVERDUE_BUCKETS).toHaveLength(AGING_BUCKETS.length - 1);
    expect(OVERDUE_BUCKETS).not.toContain("CURRENT");
    expect(OVERDUE_BUCKETS).toContain("D_180_PLUS");
  });

  it("sums to outstanding minus current", () => {
    const report = buildAgingReport(
      [overdue("LN-1", 0, 7_000), overdue("LN-2", 150, 3_000)],
      ASOF,
    );

    const par = OVERDUE_BUCKETS.reduce((a, b) => a + report.totals[b], 0);
    expect(par).toBe(report.totalOutstanding - report.totals.CURRENT);
    expect(par).toBe(3_000);
  });
});

describe("what the report leaves out", () => {
  it("ignores instalments already paid in full", () => {
    const report = buildAgingReport(
      [
        { ...overdue("LN-1", 400, 9_999), paidInFullAt: new Date() },
        overdue("LN-2", 10, 500),
      ],
      ASOF,
    );

    expect(report.rows).toHaveLength(1);
    expect(report.totalOutstanding).toBe(500);
  });

  it("ages a loan by its EARLIEST unpaid instalment", () => {
    /*
     * A borrower who missed one payment in March and has been paying
     * since is still 150 days down on that instalment. Ageing by the
     * most recent one would read the account as healthy.
     */
    const report = buildAgingReport(
      [
        { ...overdue("LN-1", 150, 1_000), installmentNo: 1 },
        { ...overdue("LN-1", 5, 1_000), installmentNo: 6 },
      ],
      ASOF,
    );

    expect(report.rows[0]!.bucket).toBe("D_121_180");
    expect(report.rows[0]!.installmentsOverdue).toBe(2);
    expect(report.rows[0]!.outstandingBalance).toBe(2_000);
  });
});
