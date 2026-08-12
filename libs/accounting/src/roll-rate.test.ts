import { describe, expect, it } from "vitest";

import {
  ROLL_RATE_DESTINATIONS,
  ROLL_RATE_ORIGINS,
  buildRollRateReport,
  rollRateStateAt,
  type LoanForRollRate,
  type RollRateDestination,
  type RollRateMatrixRow,
  type RollRateOrigin,
} from "./roll-rate";

/**
 * §30 — the matrix that says which way the book is going.
 *
 * The properties under test:
 *   • a loan's state at a PAST date is rebuilt from dueDate/paidInFullAt
 *     relative to that date — a payment dated after `from` must not
 *     count as paid at `from`;
 *   • closures and write-offs between the dates are transitions to a
 *     terminal column, not dropped rows;
 *   • loans disbursed inside the window appear on the NEW origin row;
 *   • every non-empty origin row's countFractions sum to 1.
 */

const DAY = 86_400_000;
const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-08-01T00:00:00.000Z");

const days = (base: Date, n: number) => new Date(base.getTime() + n * DAY);

let seq = 0;
function loan(
  overrides: Partial<LoanForRollRate> & {
    schedule: LoanForRollRate["schedule"];
  },
): LoanForRollRate {
  seq += 1;
  return {
    loanId: `L-${seq}`,
    loanNumber: `LN-${seq}`,
    productCode: "SALARY",
    disbursedAt: new Date("2026-01-01T00:00:00.000Z"),
    closedAt: null,
    writtenOffAt: null,
    ...overrides,
  };
}

function row(
  report: { overall: RollRateMatrixRow[] },
  origin: RollRateOrigin,
): RollRateMatrixRow {
  const r = report.overall.find((x) => x.origin === origin);
  if (!r) throw new Error(`no row for ${origin}`);
  return r;
}

function cell(r: RollRateMatrixRow, destination: RollRateDestination) {
  const c = r.cells.find((x) => x.destination === destination);
  if (!c) throw new Error(`no cell for ${destination}`);
  return c;
}

describe("single-loan transitions", () => {
  it("keeps a loan that stays current on the diagonal", () => {
    // Only installment due well after `to` — CURRENT at both dates.
    const report = buildRollRateReport(
      [
        loan({
          schedule: [
            { dueDate: days(TO, 30), totalDue: 1000, paidInFullAt: null },
          ],
        }),
      ],
      FROM,
      TO,
    );
    expect(cell(row(report, "CURRENT"), "CURRENT")).toMatchObject({
      count: 1,
      amount: 1000,
      countFraction: 1,
      amountFraction: 1,
    });
  });

  it("rolls a loan forward one band when an installment goes unpaid", () => {
    // Due 10 days after `from`: current at `from`, 21 days overdue at `to`.
    const report = buildRollRateReport(
      [
        loan({
          schedule: [
            { dueDate: days(FROM, 10), totalDue: 500, paidInFullAt: null },
          ],
        }),
      ],
      FROM,
      TO,
    );
    expect(cell(row(report, "CURRENT"), "D_1_30").count).toBe(1);
  });

  it("cures a loan back to CURRENT when the overdue installment is paid", () => {
    // Overdue 10 days at `from`; paid mid-window; a future installment remains.
    const report = buildRollRateReport(
      [
        loan({
          schedule: [
            {
              dueDate: days(FROM, -10),
              totalDue: 500,
              paidInFullAt: days(FROM, 5),
            },
            { dueDate: days(TO, 30), totalDue: 500, paidInFullAt: null },
          ],
        }),
      ],
      FROM,
      TO,
    );
    const c = cell(row(report, "D_1_30"), "CURRENT");
    expect(c.count).toBe(1);
    // Exposure measured at `from`: both installments were unpaid then.
    expect(c.amount).toBe(1000);
  });

  it("sends a loan paid off in-window to the CLOSED column", () => {
    const report = buildRollRateReport(
      [
        loan({
          closedAt: days(FROM, 12),
          schedule: [
            {
              dueDate: days(FROM, -10),
              totalDue: 700,
              paidInFullAt: days(FROM, 12),
            },
          ],
        }),
      ],
      FROM,
      TO,
    );
    expect(cell(row(report, "D_1_30"), "CLOSED").count).toBe(1);
  });

  it("treats a fully-settled schedule as CLOSED even without a closedAt stamp", () => {
    const report = buildRollRateReport(
      [
        loan({
          schedule: [
            {
              dueDate: days(FROM, -10),
              totalDue: 700,
              paidInFullAt: days(FROM, 12),
            },
          ],
        }),
      ],
      FROM,
      TO,
    );
    expect(cell(row(report, "D_1_30"), "CLOSED").count).toBe(1);
  });

  it("sends a loan written off in-window to the WRITTEN_OFF column", () => {
    const report = buildRollRateReport(
      [
        loan({
          writtenOffAt: days(FROM, 20),
          schedule: [
            { dueDate: days(FROM, -200), totalDue: 900, paidInFullAt: null },
          ],
        }),
      ],
      FROM,
      TO,
    );
    const c = cell(row(report, "D_180_PLUS"), "WRITTEN_OFF");
    expect(c.count).toBe(1);
    expect(c.amount).toBe(900); // exposure at `from`, not zero
  });

  it("puts a loan disbursed inside the window on the NEW origin row", () => {
    const report = buildRollRateReport(
      [
        loan({
          disbursedAt: days(FROM, 15),
          schedule: [
            { dueDate: days(TO, 15), totalDue: 2000, paidInFullAt: null },
          ],
        }),
      ],
      FROM,
      TO,
    );
    const c = cell(row(report, "NEW"), "CURRENT");
    expect(c.count).toBe(1);
    // NEW has no `from` exposure; the amount is the outstanding at `to`.
    expect(c.amount).toBe(2000);
  });

  it("drops a loan that left the book before the window opened", () => {
    const report = buildRollRateReport(
      [
        loan({
          closedAt: days(FROM, -5),
          schedule: [
            {
              dueDate: days(FROM, -30),
              totalDue: 100,
              paidInFullAt: days(FROM, -5),
            },
          ],
        }),
      ],
      FROM,
      TO,
    );
    expect(report.totalLoans).toBe(0);
  });
});

describe("past-snapshot reconstruction", () => {
  it("does not count a payment dated after `from` as paid at `from`", () => {
    // The property that makes the whole report honest: this loan's only
    // overdue installment was settled AFTER `from`, so at `from` it must
    // still classify as overdue — not CURRENT, and not CLOSED.
    const l = loan({
      schedule: [
        {
          dueDate: days(FROM, -10),
          totalDue: 500,
          paidInFullAt: days(FROM, 3),
        },
      ],
    });
    const at = rollRateStateAt(l, FROM);
    expect(at).toMatchObject({
      kind: "BAND",
      bucket: "D_1_30",
      outstanding: 500,
    });
  });

  it("does not count a closure dated after `from` as closed at `from`", () => {
    const l = loan({
      closedAt: days(FROM, 3),
      schedule: [
        {
          dueDate: days(FROM, -10),
          totalDue: 500,
          paidInFullAt: days(FROM, 3),
        },
      ],
    });
    expect(rollRateStateAt(l, FROM).kind).toBe("BAND");
    expect(rollRateStateAt(l, TO).kind).toBe("CLOSED");
  });

  it("does count a payment dated before `from` as paid at `from`", () => {
    const l = loan({
      schedule: [
        {
          dueDate: days(FROM, -40),
          totalDue: 500,
          paidInFullAt: days(FROM, -20),
        },
        { dueDate: days(FROM, 40), totalDue: 500, paidInFullAt: null },
      ],
    });
    // The settled row is out of the picture; only the future one remains.
    expect(rollRateStateAt(l, FROM)).toMatchObject({
      kind: "BAND",
      bucket: "CURRENT",
      outstanding: 500,
    });
  });

  it("treats a loan not yet disbursed at the snapshot as absent", () => {
    const l = loan({
      disbursedAt: days(FROM, 10),
      schedule: [{ dueDate: days(TO, 30), totalDue: 100, paidInFullAt: null }],
    });
    expect(rollRateStateAt(l, FROM).kind).toBe("ABSENT");
  });
});

describe("matrix invariants", () => {
  const portfolio: LoanForRollRate[] = [
    // stays current
    loan({
      schedule: [{ dueDate: days(TO, 30), totalDue: 1000, paidInFullAt: null }],
    }),
    // rolls CURRENT → D_1_30
    loan({
      schedule: [
        { dueDate: days(FROM, 10), totalDue: 500, paidInFullAt: null },
      ],
    }),
    // rolls D_1_30 → D_31_60
    loan({
      schedule: [
        { dueDate: days(FROM, -20), totalDue: 800, paidInFullAt: null },
      ],
    }),
    // cures D_1_30 → CURRENT
    loan({
      schedule: [
        {
          dueDate: days(FROM, -10),
          totalDue: 300,
          paidInFullAt: days(FROM, 5),
        },
        { dueDate: days(TO, 30), totalDue: 300, paidInFullAt: null },
      ],
    }),
    // closes
    loan({
      closedAt: days(FROM, 12),
      schedule: [
        {
          dueDate: days(FROM, -10),
          totalDue: 700,
          paidInFullAt: days(FROM, 12),
        },
      ],
    }),
    // written off
    loan({
      writtenOffAt: days(FROM, 20),
      productCode: "BUSINESS_SME",
      schedule: [
        { dueDate: days(FROM, -200), totalDue: 900, paidInFullAt: null },
      ],
    }),
    // new entrant
    loan({
      disbursedAt: days(FROM, 15),
      productCode: "BUSINESS_SME",
      schedule: [{ dueDate: days(TO, 15), totalDue: 2000, paidInFullAt: null }],
    }),
  ];

  const report = buildRollRateReport(portfolio, FROM, TO);

  it("counts every loan exactly once", () => {
    expect(report.totalLoans).toBe(7);
    const total = report.overall.reduce((s, r) => s + r.loanCount, 0);
    expect(total).toBe(7);
  });

  it("sums every non-empty origin row's countFractions to 1", () => {
    for (const r of report.overall) {
      if (r.loanCount === 0) continue;
      const sum = r.cells.reduce((s, c) => s + c.countFraction, 0);
      // 4-dp rounding on each cell can drift the sum by < 0.001.
      expect(Math.abs(sum - 1)).toBeLessThan(0.001);
    }
  });

  it("leaves empty origin rows all-zero rather than NaN", () => {
    const empty = report.overall.find((r) => r.loanCount === 0);
    expect(empty).toBeDefined();
    for (const c of empty!.cells) {
      expect(c.countFraction).toBe(0);
      expect(c.amountFraction).toBe(0);
    }
  });

  it("orders rows and columns by the exported constants", () => {
    expect(report.origins).toEqual(ROLL_RATE_ORIGINS);
    expect(report.destinations).toEqual(ROLL_RATE_DESTINATIONS);
    expect(report.overall.map((r) => r.origin)).toEqual([...ROLL_RATE_ORIGINS]);
  });

  it("splits the same transitions by product, losing none", () => {
    expect(report.byProduct.map((p) => p.productCode)).toEqual([
      "BUSINESS_SME",
      "SALARY",
    ]);
    const perProductTotal = report.byProduct
      .flatMap((p) => p.rows)
      .reduce((s, r) => s + r.loanCount, 0);
    expect(perProductTotal).toBe(7);
    const sme = report.byProduct.find((p) => p.productCode === "BUSINESS_SME")!;
    expect(
      sme.rows
        .find((r) => r.origin === "NEW")!
        .cells.find((c) => c.destination === "CURRENT")!.count,
    ).toBe(1);
    expect(
      sme.rows
        .find((r) => r.origin === "D_180_PLUS")!
        .cells.find((c) => c.destination === "WRITTEN_OFF")!.count,
    ).toBe(1);
  });
});
