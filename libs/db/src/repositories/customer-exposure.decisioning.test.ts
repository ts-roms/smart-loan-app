import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { CustomerExposureRepository } from "./customer-exposure.repository";

/**
 * `forDecision` — consolidated exposure as an underwriting input.
 *
 * The consolidated view answers "how much does this member owe". §16's
 * disposable income needs a different question answered: "how much do
 * they PAY, per month". No column holds that, so it is folded out of
 * the schedules — and the interesting failures are all about which
 * instalments end up inside the fold.
 *
 * Three of them, in order of how quietly they would have gone wrong:
 *
 *   • Arrears counted twice. Money already overdue reaches the engine
 *     as `existingPastDue`. If the monthly window reached backwards it
 *     would also be inside `monthlyObligations`, and §16 would subtract
 *     the same peso from the borrower's income twice.
 *   • A restructured predecessor counted alongside its successor —
 *     the double-count `consolidatedExposure` excludes it to prevent,
 *     reintroduced one layer down by a window that ran over every loan
 *     instead of the counted ones.
 *   • A month-end start date sweeping up two instalments, so the same
 *     borrower's obligation doubles depending on which day of the month
 *     the officer opened the application.
 */

interface ScheduleRow {
  loanId: string;
  dueDate: Date;
  paidInFullAt: Date | null;
  totalDue: number;
  principalDue: number;
  principalPaid: number;
  interestPaid: number;
}

interface LoanRow {
  id: string;
  number: string;
  productCode: string;
  principal: number;
  status: string;
  writeOffAmount: number | null;
}

/**
 * Enough of Prisma to answer the two queries this path makes: the
 * borrower's loans, and one `groupBy` per schedule window. The groupBy
 * honours `loanId.in`, `paidInFullAt` and the `dueDate` range, because
 * those three are exactly what the windows differ by — a fake that
 * ignored the `where` would pass every test in this file while the real
 * query returned the whole schedule.
 */
function fakePrisma(loans: LoanRow[], schedule: ScheduleRow[]): PrismaClient {
  const groupBy = async (args: {
    where: {
      loanId?: { in: string[] };
      paidInFullAt?: null;
      dueDate?: { lt?: Date; gte?: Date };
    };
  }) => {
    const w = args.where;
    const rows = schedule.filter((r) => {
      if (w.loanId && !w.loanId.in.includes(r.loanId)) return false;
      if (w.paidInFullAt === null && r.paidInFullAt !== null) return false;
      if (w.dueDate?.lt && !(r.dueDate < w.dueDate.lt)) return false;
      if (w.dueDate?.gte && !(r.dueDate >= w.dueDate.gte)) return false;
      return true;
    });

    const byLoan = new Map<string, ScheduleRow[]>();
    for (const r of rows) {
      const list = byLoan.get(r.loanId) ?? [];
      list.push(r);
      byLoan.set(r.loanId, list);
    }

    return [...byLoan.entries()].map(([loanId, rs]) => ({
      loanId,
      _sum: {
        totalDue: rs.reduce((s, r) => s + r.totalDue, 0),
        principalDue: rs.reduce((s, r) => s + r.principalDue, 0),
        principalPaid: rs.reduce((s, r) => s + r.principalPaid, 0),
        interestPaid: rs.reduce((s, r) => s + r.interestPaid, 0),
      },
      _count: {
        _all: rs.length,
        paidInFullAt: rs.filter((r) => r.paidInFullAt !== null).length,
      },
    }));
  };

  return {
    loanApplication: { findMany: async () => loans },
    loanSchedule: { groupBy },
  } as unknown as PrismaClient;
}

const loan = (over: Partial<LoanRow> & { id: string }): LoanRow => ({
  number: `LN-${over.id}`,
  productCode: "SALARY",
  principal: 100_000,
  status: "ACTIVE",
  writeOffAmount: null,
  ...over,
});

/** One instalment, `totalDue` unpaid unless told otherwise. */
const due = (
  loanId: string,
  dueDate: string,
  totalDue: number,
  paid = false,
): ScheduleRow => ({
  loanId,
  dueDate: new Date(dueDate),
  paidInFullAt: paid ? new Date(dueDate) : null,
  totalDue,
  principalDue: totalDue * 0.8,
  principalPaid: paid ? totalDue * 0.8 : 0,
  interestPaid: paid ? totalDue * 0.2 : 0,
});

const ASOF = new Date("2026-06-15T00:00:00.000Z");

describe("forDecision — the monthly obligation", () => {
  it("sums the next month's unpaid instalments across live loans", () => {
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [loan({ id: "l1" }), loan({ id: "l2" })],
        [
          due("l1", "2026-06-20", 5_000),
          due("l2", "2026-07-01", 3_200),
          // Beyond the window — next month's problem, not this one's.
          due("l1", "2026-07-20", 5_000),
        ],
      ),
    );

    return repo.forDecision("cust-1", ASOF).then((r) => {
      expect(r.monthlyObligations).toBe(8_200);
    });
  });

  it("does NOT count arrears — they are reported separately", async () => {
    /*
     * The double-count that §16 would otherwise commit. ₱9,000 is
     * already overdue; it belongs in `existingPastDue`, and subtracting
     * it from income as though it were also next month's amortization
     * would overstate the borrower's commitments by its full value.
     */
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [loan({ id: "l1" })],
        [
          due("l1", "2026-04-20", 4_500),
          due("l1", "2026-05-20", 4_500),
          due("l1", "2026-06-20", 5_000),
        ],
      ),
    );

    const r = await repo.forDecision("cust-1", ASOF);

    expect(r.monthlyObligations).toBe(5_000);
    // The arrears are not lost — they are on the other field.
    expect(r.exposure.total.pastDue).toBe(9_000);
  });

  it("ignores instalments already settled inside the window", async () => {
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [loan({ id: "l1" })],
        [due("l1", "2026-06-20", 5_000, true), due("l1", "2026-06-27", 5_000)],
      ),
    );

    const r = await repo.forDecision("cust-1", ASOF);
    expect(r.monthlyObligations).toBe(5_000);
  });

  it("counts a bi-weekly loan's two instalments, not one", async () => {
    // Frequency falls out of the window rather than being special-cased:
    // what a loan costs per month is what falls due in a month.
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [loan({ id: "l1" })],
        [due("l1", "2026-06-20", 2_500), due("l1", "2026-07-04", 2_500)],
      ),
    );

    const r = await repo.forDecision("cust-1", ASOF);
    expect(r.monthlyObligations).toBe(5_000);
  });
});

describe("forDecision — which loans are in scope", () => {
  it("skips a RESTRUCTURED predecessor whose successor is also on file", async () => {
    /*
     * `consolidatedExposure` excludes RESTRUCTURED precisely because a
     * successor loan replaced it and IS counted. A monthly window run
     * over every row would fold the dead loan's schedule back in and
     * double the borrower's obligation.
     */
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [
          loan({ id: "old", status: "RESTRUCTURED" }),
          loan({ id: "new", status: "ACTIVE" }),
        ],
        [due("old", "2026-06-20", 6_000), due("new", "2026-06-25", 7_000)],
      ),
    );

    const r = await repo.forDecision("cust-1", ASOF);
    expect(r.monthlyObligations).toBe(7_000);
  });

  it("skips a WRITTEN_OFF loan while still reporting what it cost", async () => {
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [
          loan({ id: "wo", status: "WRITTEN_OFF", writeOffAmount: 62_000 }),
          loan({ id: "live", status: "ACTIVE" }),
        ],
        [due("wo", "2026-06-20", 4_000), due("live", "2026-06-22", 5_500)],
      ),
    );

    const r = await repo.forDecision("cust-1", ASOF);

    // Collection was abandoned; there is no monthly obligation left.
    expect(r.monthlyObligations).toBe(5_500);
    // But the write-off itself stays visible — per exposure.ts, the
    // single most important fact about this borrower.
    expect(r.exposure.excluded.writtenOffPrincipal).toBe(62_000);
  });

  it("counts a DEFAULTED loan — stopped paying is not stopped owing", async () => {
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [loan({ id: "d", status: "DEFAULTED" })],
        [due("d", "2026-06-20", 5_000)],
      ),
    );

    const r = await repo.forDecision("cust-1", ASOF);
    expect(r.monthlyObligations).toBe(5_000);
    expect(r.exposure.total.activeLoans).toBe(1);
  });

  it("reports zero for an APPROVED loan with no schedule yet", async () => {
    /*
     * Inside `exposure.total` — the lender has committed the money —
     * but nothing is due on it, because no instalment exists to be due.
     * Quoting a guessed amortization here would put a figure on the
     * decision record that no schedule backs.
     */
    const repo = new CustomerExposureRepository(
      fakePrisma([loan({ id: "a", status: "APPROVED" })], []),
    );

    const r = await repo.forDecision("cust-1", ASOF);
    expect(r.monthlyObligations).toBe(0);
    expect(r.exposure.total.principalOutstanding).toBe(100_000);
  });

  it("returns zeros for a borrower with no loans at all", async () => {
    const repo = new CustomerExposureRepository(fakePrisma([], []));
    const r = await repo.forDecision("cust-1", ASOF);

    expect(r.monthlyObligations).toBe(0);
    expect(r.exposure.total.principalOutstanding).toBe(0);
    expect(r.exposure.loans).toEqual([]);
  });
});

describe("forDecision — the window is one month whatever the start date", () => {
  it("does not sweep up two instalments when run on the 31st", async () => {
    /*
     * Naive `setMonth(+1)` turns 31 January into 3 March, and the
     * window then contains both February's and March's instalments —
     * doubling the borrower's reported obligation for no reason but the
     * day the officer happened to open the file.
     */
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [loan({ id: "l1" })],
        [due("l1", "2026-02-05", 5_000), due("l1", "2026-03-05", 5_000)],
      ),
    );

    const r = await repo.forDecision(
      "cust-1",
      new Date("2026-01-31T00:00:00.000Z"),
    );
    expect(r.monthlyObligations).toBe(5_000);
  });

  it("gives the same figure on the 1st and the 28th of a month", async () => {
    const schedule = [
      due("l1", "2026-03-10", 5_000),
      due("l1", "2026-04-10", 5_000),
      due("l1", "2026-05-10", 5_000),
    ];
    const repo = new CustomerExposureRepository(
      fakePrisma([loan({ id: "l1" })], schedule),
    );

    const first = await repo.forDecision(
      "cust-1",
      new Date("2026-03-01T00:00:00.000Z"),
    );
    const late = await repo.forDecision(
      "cust-1",
      new Date("2026-03-28T00:00:00.000Z"),
    );

    expect(first.monthlyObligations).toBe(5_000);
    expect(late.monthlyObligations).toBe(5_000);
  });

  it("echoes back the instant every figure was measured at", async () => {
    // §20: a decision has to be reproducible, and "past due" is only
    // meaningful relative to a moment.
    const repo = new CustomerExposureRepository(fakePrisma([], []));
    const r = await repo.forDecision("cust-1", ASOF);
    expect(r.asOf).toBe(ASOF);
  });
});

describe("build — unchanged by the decisioning path", () => {
  it("still returns the customer-facing shape", async () => {
    /*
     * `build` and `forDecision` now share one fold. The profile panel
     * and the underwriting decision reading different numbers for the
     * same borrower is the failure the shared fold exists to prevent,
     * so the older entry point is pinned here too.
     */
    const repo = new CustomerExposureRepository(
      fakePrisma(
        [loan({ id: "l1" }), loan({ id: "l2", status: "CLOSED" })],
        [due("l1", "2026-06-20", 5_000)],
      ),
    );

    const r = await repo.build("cust-1", "CUST-2026-0001", ASOF);

    expect(r.customerId).toBe("cust-1");
    expect(r.customerNumber).toBe("CUST-2026-0001");
    expect(r.asOf).toBe(ASOF.toISOString());
    expect(r.loans).toHaveLength(2);
    expect(r.total.activeLoans).toBe(1);
    expect(r.excluded.closedLoans).toBe(1);
  });
});
