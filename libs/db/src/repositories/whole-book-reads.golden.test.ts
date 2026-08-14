import { describe, expect, it } from "vitest";

import { type BookFixture, inMemoryBook } from "../testing/in-memory-book";
import { AccountingRepository } from "./accounting.repository";
import { CollectionsRepository } from "./collections.repository";

/**
 * GOLDEN TESTS — the three whole-book reads of finding F4.
 *
 *   `loanPortfolioAging`  (accounting.repository.ts)
 *   `rollRate`            (accounting.repository.ts)
 *   `overdueQueue`        (collections.repository.ts)
 *
 * Written against the CURRENT implementation and committed passing BEFORE the
 * F4 refactor (docs/modernization/query-performance.md), per §81. All three
 * feed decisions about money: the aging bands and the roll-rate matrix drive
 * provisioning, and the queue's ordering decides which borrower gets chased
 * first. Bounding how those rows are DELIVERED must not move a single band
 * total, drop a single loan out of a bucket, or reorder the queue.
 *
 * What these tests therefore pin, and why each one matters:
 *
 *   1. TOTALS — every aging band, and `totalOutstanding`. A total is computed
 *      over the whole book by definition; it cannot be derived from a page.
 *      If pagination moves one of these, the refactor is wrong.
 *   2. MEMBERSHIP — which loan lands in which bucket, and which loans are on
 *      the queue at all. A loan silently dropped from a band is a
 *      provisioning error that no total would necessarily reveal.
 *   3. ORDER — the queue's global ranking, top to bottom. The §29 score is
 *      computed in JavaScript after the fetch, so any change that scores a
 *      subset rather than the book would reorder this list. That is the
 *      single most important assertion in this file.
 *
 * The fixture is deliberately small enough to fit in one page under any
 * sensible default page size, so these assertions read the same before and
 * after: the refactor is not allowed to need a bigger fixture to look correct.
 *
 * Money is stated as exact 2-decimal strings because that is what
 * `Decimal(14,2)` stores. Every expected number below was computed by hand
 * from the fixture first, then confirmed against the unmodified
 * implementation — not read off a failing run and pasted back.
 */

// ─── The book ──────────────────────────────────────────────────────────
//
// Six loans over four borrowers, chosen so that every branch the three
// reads can take is exercised at least once:
//
//   L1 ACTIVE, deep arrears, contactable, one kept and one broken promise,
//      borrower has a prior CLOSED loan          → queue + aging + roll-rate
//   L2 DEFAULTED, ancient arrears, NO contact channels at all, borrower has
//      a prior WRITTEN_OFF loan                  → queue + aging + roll-rate
//   L3 ACTIVE, freshly overdue, secured on a vehicle, never contacted
//                                                → queue + aging + roll-rate
//   L4 ACTIVE but CURRENT — nothing past due     → aging + roll-rate, NOT queue
//   L5 CLOSED inside the window                  → roll-rate only
//   L6 WRITTEN_OFF inside the window             → roll-rate only
//
// L2 is also the self-counting guard: it is DEFAULTED *and* on the queue, so
// the prior-history lookup must exclude it from its own borrower's history.

const AS_OF = new Date("2026-06-30T00:00:00.000Z");
const FROM = new Date("2026-03-31T00:00:00.000Z");
const TO = AS_OF;

/** An unpaid instalment; principal/interest split 60/40, nothing collected. */
function due(id: string, no: number, iso: string, total: string) {
  const t = Number(total);
  return {
    id,
    installmentNo: no,
    dueDate: new Date(iso),
    principalDue: (t * 0.6).toFixed(2),
    interestDue: (t * 0.4).toFixed(2),
    totalDue: t.toFixed(2),
    principalPaid: "0.00",
    interestPaid: "0.00",
    paidInFullAt: null,
  };
}

/** A settled instalment — paid in full on `paidIso`. */
function settled(
  id: string,
  no: number,
  iso: string,
  total: string,
  paidIso: string,
) {
  const t = Number(total);
  return {
    id,
    installmentNo: no,
    dueDate: new Date(iso),
    principalDue: (t * 0.6).toFixed(2),
    interestDue: (t * 0.4).toFixed(2),
    totalDue: t.toFixed(2),
    principalPaid: (t * 0.6).toFixed(2),
    interestPaid: (t * 0.4).toFixed(2),
    paidInFullAt: new Date(paidIso),
  };
}

const FIXTURE: BookFixture = {
  customers: [
    {
      id: "cus-1",
      firstName: "Ana",
      lastName: "Reyes",
      city: "Cebu City",
      province: "Cebu",
      phone: "+63 917 000 0001",
      secondaryPhone: null,
      email: "ana@example.com",
      creditTier: "F",
    },
    {
      // No phone, no alternate, no email: the uncontactable branch.
      id: "cus-2",
      firstName: "Ben",
      lastName: "Cruz",
      city: "Davao City",
      province: "Davao del Sur",
      phone: null,
      secondaryPhone: null,
      email: null,
      creditTier: null, // never scored — the neutral-0.5 branch
    },
    {
      id: "cus-3",
      firstName: "Carla",
      lastName: "Diaz",
      city: "Cebu City",
      province: "Cebu",
      phone: "+63 917 000 0003",
      secondaryPhone: null,
      email: null,
      creditTier: "A",
    },
    {
      id: "cus-4",
      firstName: "Dan",
      lastName: "Evans",
      city: "Manila",
      province: "Metro Manila",
      phone: "+63 917 000 0004",
      secondaryPhone: "+63 918 000 0004",
      email: "dan@example.com",
      creditTier: "C",
    },
  ],
  loans: [
    {
      id: "loan-1",
      number: "LN-0001",
      customerId: "cus-1",
      productCode: "SALARY",
      principal: "20000.00",
      status: "ACTIVE",
      disbursedAt: new Date("2025-06-01T00:00:00.000Z"),
      closedAt: null,
      writtenOffAt: null,
      schedule: [
        settled(
          "s1-1",
          1,
          "2026-01-15T00:00:00.000Z",
          "5000",
          "2026-01-15T00:00:00.000Z",
        ),
        due("s1-2", 2, "2026-02-15T00:00:00.000Z", "5000"),
        due("s1-3", 3, "2026-03-15T00:00:00.000Z", "5000"),
        due("s1-4", 4, "2026-07-15T00:00:00.000Z", "5000"), // not yet due
      ],
      assignment: {
        collectorId: "col-1",
        collectorName: "Grace Lim",
        assignedAt: new Date("2026-06-01T00:00:00.000Z"),
        note: "Priority account",
      },
      promises: [
        {
          status: "HONORED",
          promisedDate: new Date("2026-04-10T00:00:00.000Z"),
        },
        {
          status: "BROKEN",
          promisedDate: new Date("2026-05-10T00:00:00.000Z"),
        },
      ],
      notes: [{ createdAt: new Date("2026-06-20T00:00:00.000Z") }],
    },
    {
      id: "loan-2",
      number: "LN-0002",
      customerId: "cus-2",
      productCode: "SALARY",
      principal: "16000.00",
      status: "DEFAULTED",
      disbursedAt: new Date("2024-09-01T00:00:00.000Z"),
      closedAt: null,
      writtenOffAt: null,
      schedule: [
        due("s2-1", 1, "2025-01-10T00:00:00.000Z", "8000"),
        due("s2-2", 2, "2025-02-10T00:00:00.000Z", "8000"),
      ],
      assignment: null,
      promises: [],
      notes: [],
    },
    {
      id: "loan-3",
      number: "LN-0003",
      customerId: "cus-3",
      productCode: "AUTO",
      principal: "36000.00",
      status: "ACTIVE",
      disbursedAt: new Date("2026-01-05T00:00:00.000Z"),
      closedAt: null,
      writtenOffAt: null,
      schedule: [
        settled(
          "s3-1",
          1,
          "2026-02-05T00:00:00.000Z",
          "12000",
          "2026-02-05T00:00:00.000Z",
        ),
        due("s3-2", 2, "2026-06-10T00:00:00.000Z", "12000"),
        due("s3-3", 3, "2026-07-10T00:00:00.000Z", "12000"),
      ],
      assignment: null,
      promises: [],
      notes: [],
      vehicleValue: "300000.00",
    },
    {
      // Nothing past due: in the aging report as CURRENT, never on the queue.
      id: "loan-4",
      number: "LN-0004",
      customerId: "cus-4",
      productCode: "SALARY",
      principal: "3000.00",
      status: "ACTIVE",
      disbursedAt: new Date("2026-05-01T00:00:00.000Z"), // after FROM → NEW
      closedAt: null,
      writtenOffAt: null,
      schedule: [due("s4-1", 1, "2026-08-01T00:00:00.000Z", "3000")],
      assignment: null,
      promises: [],
      notes: [],
    },
    {
      id: "loan-5",
      number: "LN-0005",
      customerId: "cus-1",
      productCode: "SALARY",
      principal: "8000.00",
      status: "CLOSED",
      disbursedAt: new Date("2025-01-01T00:00:00.000Z"),
      closedAt: new Date("2026-05-20T00:00:00.000Z"), // inside the window
      writtenOffAt: null,
      schedule: [
        settled(
          "s5-1",
          1,
          "2025-02-01T00:00:00.000Z",
          "4000",
          "2025-02-01T00:00:00.000Z",
        ),
        settled(
          "s5-2",
          2,
          "2025-03-01T00:00:00.000Z",
          "4000",
          "2026-05-20T00:00:00.000Z",
        ),
      ],
    },
    {
      id: "loan-6",
      number: "LN-0006",
      customerId: "cus-2",
      productCode: "AUTO",
      principal: "9000.00",
      status: "WRITTEN_OFF",
      disbursedAt: new Date("2025-03-01T00:00:00.000Z"),
      closedAt: null,
      writtenOffAt: new Date("2026-06-01T00:00:00.000Z"), // inside the window
      schedule: [due("s6-1", 1, "2025-04-01T00:00:00.000Z", "9000")],
    },
  ],
};

const book = () => inMemoryBook(FIXTURE);

// ─── 1. loanPortfolioAging ─────────────────────────────────────────────

describe("loanPortfolioAging — golden", () => {
  /*
   * Hand-computed from the fixture, as of 2026-06-30:
   *
   *   L1  open 5000+5000+5000 = 15,000; earliest unpaid-and-due 2026-02-15
   *       → 135 days → D_121_180; 2 instalments overdue (the 2026-07-15 one
   *       is open but not yet due)
   *   L2  open 8000+8000 = 16,000; earliest 2025-01-10 → 536 days
   *       → D_180_PLUS; 2 overdue
   *   L3  open 12,000+12,000 = 24,000; earliest 2026-06-10 → 20 days
   *       → D_1_30; 1 overdue
   *   L4  open 3,000; nothing past due → 0 days → CURRENT; 0 overdue
   *
   *   L5 (CLOSED) and L6 (WRITTEN_OFF) are outside the status filter and
   *   must not appear at all.
   */

  it("totals every band over the whole book", async () => {
    const { prisma } = book();
    const report = await new AccountingRepository(prisma).loanPortfolioAging(
      AS_OF,
    );

    expect(report.totals).toEqual({
      CURRENT: 3000,
      D_1_30: 24000,
      D_31_60: 0,
      D_61_90: 0,
      D_91_120: 0,
      D_121_180: 15000,
      D_180_PLUS: 16000,
    });
    // The bands must add up to the reported total, and the total must be the
    // whole book — 15,000 + 16,000 + 24,000 + 3,000.
    expect(report.totalOutstanding).toBe(58000);
    expect(Object.values(report.totals).reduce((s, v) => s + v, 0)).toBe(
      report.totalOutstanding,
    );
  });

  it("places every loan in its band, and excludes closed and written-off ones", async () => {
    const { prisma } = book();
    const report = await new AccountingRepository(prisma).loanPortfolioAging(
      AS_OF,
    );

    // Ordered by daysOverdue desc, then loan number.
    expect(report.rows.map((r) => r.loanNumber)).toEqual([
      "LN-0002",
      "LN-0001",
      "LN-0003",
      "LN-0004",
    ]);

    expect(report.rows).toEqual([
      {
        loanId: "loan-2",
        loanNumber: "LN-0002",
        customerName: "Ben Cruz",
        outstandingBalance: 16000,
        installmentsOverdue: 2,
        daysOverdue: 536,
        bucket: "D_180_PLUS",
      },
      {
        loanId: "loan-1",
        loanNumber: "LN-0001",
        customerName: "Ana Reyes",
        outstandingBalance: 15000,
        installmentsOverdue: 2,
        daysOverdue: 135,
        bucket: "D_121_180",
      },
      {
        loanId: "loan-3",
        loanNumber: "LN-0003",
        customerName: "Carla Diaz",
        outstandingBalance: 24000,
        installmentsOverdue: 1,
        daysOverdue: 20,
        bucket: "D_1_30",
      },
      {
        loanId: "loan-4",
        loanNumber: "LN-0004",
        customerName: "Dan Evans",
        outstandingBalance: 3000,
        installmentsOverdue: 0,
        daysOverdue: 0,
        bucket: "CURRENT",
      },
    ]);
  });

  it("reports the asOf it was asked for", async () => {
    const { prisma } = book();
    const report = await new AccountingRepository(prisma).loanPortfolioAging(
      AS_OF,
    );
    expect(report.asOf).toBe(AS_OF.toISOString());
  });
});

// ─── 2. rollRate ───────────────────────────────────────────────────────

describe("rollRate — golden", () => {
  /*
   * Hand-computed state at FROM (2026-03-31) → TO (2026-06-30):
   *
   *   L1  D_31_60 (44 days)      → D_121_180 (135)      SALARY  15,000
   *   L2  D_180_PLUS (445)       → D_180_PLUS (536)     SALARY  16,000
   *   L3  CURRENT (0)            → D_1_30 (20)          AUTO    24,000
   *   L4  ABSENT (not disbursed) → CURRENT (0)          SALARY   3,000
   *   L5  D_180_PLUS (395)       → CLOSED               SALARY   4,000
   *   L6  D_180_PLUS (364)       → WRITTEN_OFF          AUTO     9,000
   *
   * `amount` is the exposure at FROM, except for the NEW row, which has no
   * FROM exposure and carries its TO exposure instead.
   */

  const cell = (
    rows: Array<{
      origin: string;
      cells: Array<{ destination: string; count: number; amount: number }>;
    }>,
    origin: string,
    destination: string,
  ) =>
    rows
      .find((r) => r.origin === origin)!
      .cells.find((c) => c.destination === destination)!;

  it("counts every loan that produced a transition", async () => {
    const { prisma } = book();
    const report = await new AccountingRepository(prisma).rollRate(FROM, TO);
    expect(report.totalLoans).toBe(6);
    expect(report.from).toBe(FROM.toISOString());
    expect(report.to).toBe(TO.toISOString());
  });

  it("puts every transition in the right cell, with the right exposure", async () => {
    const { prisma } = book();
    const report = await new AccountingRepository(prisma).rollRate(FROM, TO);
    const rows = report.overall;

    expect(cell(rows, "D_31_60", "D_121_180")).toMatchObject({
      count: 1,
      amount: 15000,
    });
    expect(cell(rows, "D_180_PLUS", "D_180_PLUS")).toMatchObject({
      count: 1,
      amount: 16000,
    });
    expect(cell(rows, "CURRENT", "D_1_30")).toMatchObject({
      count: 1,
      amount: 24000,
    });
    expect(cell(rows, "NEW", "CURRENT")).toMatchObject({
      count: 1,
      amount: 3000,
    });
    expect(cell(rows, "D_180_PLUS", "CLOSED")).toMatchObject({
      count: 1,
      amount: 4000,
    });
    expect(cell(rows, "D_180_PLUS", "WRITTEN_OFF")).toMatchObject({
      count: 1,
      amount: 9000,
    });
  });

  it("totals each origin row over the whole book", async () => {
    const { prisma } = book();
    const report = await new AccountingRepository(prisma).rollRate(FROM, TO);
    const row = (origin: string) =>
      report.overall.find((r) => r.origin === origin)!;

    // Three loans left D_180_PLUS three different ways; the row must hold
    // all of them and their exposures must add up.
    expect(row("D_180_PLUS")).toMatchObject({
      loanCount: 3,
      amount: 29000, // 16,000 + 4,000 + 9,000
    });
    expect(row("D_31_60")).toMatchObject({ loanCount: 1, amount: 15000 });
    expect(row("CURRENT")).toMatchObject({ loanCount: 1, amount: 24000 });
    expect(row("NEW")).toMatchObject({ loanCount: 1, amount: 3000 });
    expect(row("D_1_30")).toMatchObject({ loanCount: 0, amount: 0 });
    expect(row("D_61_90")).toMatchObject({ loanCount: 0, amount: 0 });
    expect(row("D_91_120")).toMatchObject({ loanCount: 0, amount: 0 });
    expect(row("D_121_180")).toMatchObject({ loanCount: 0, amount: 0 });

    // Every loan on a row lands in exactly one destination. The three cells
    // are 1/3 each and each is rounded to 4 dp independently, so the row sums
    // to 0.9999 — the ±4dp tolerance roll-rate.ts documents, not a lost loan.
    expect(
      row("D_180_PLUS").cells.reduce((s, c) => s + c.countFraction, 0),
    ).toBeCloseTo(1, 3);
    // And the exposures split the row's amount the same way.
    expect(cell(report.overall, "D_180_PLUS", "WRITTEN_OFF")).toMatchObject({
      amountFraction: 0.3103, // 9,000 / 29,000
    });
  });

  it("breaks the same matrix down by product", async () => {
    const { prisma } = book();
    const report = await new AccountingRepository(prisma).rollRate(FROM, TO);

    expect(report.byProduct.map((p) => p.productCode)).toEqual([
      "AUTO",
      "SALARY",
    ]);

    const auto = report.byProduct.find((p) => p.productCode === "AUTO")!.rows;
    expect(cell(auto, "CURRENT", "D_1_30")).toMatchObject({
      count: 1,
      amount: 24000,
    });
    expect(cell(auto, "D_180_PLUS", "WRITTEN_OFF")).toMatchObject({
      count: 1,
      amount: 9000,
    });

    const salary = report.byProduct.find(
      (p) => p.productCode === "SALARY",
    )!.rows;
    expect(cell(salary, "D_31_60", "D_121_180")).toMatchObject({ count: 1 });
    expect(cell(salary, "D_180_PLUS", "CLOSED")).toMatchObject({ count: 1 });
    expect(cell(salary, "NEW", "CURRENT")).toMatchObject({ count: 1 });
    // The AUTO write-off must NOT leak into the SALARY breakdown.
    expect(cell(salary, "D_180_PLUS", "WRITTEN_OFF")).toMatchObject({
      count: 0,
      amount: 0,
    });
  });
});

// ─── 3. overdueQueue ───────────────────────────────────────────────────

describe("overdueQueue — golden", () => {
  /*
   * The §29 score, hand-computed from the weights in
   * libs/collections/src/weights.ts (exposure .24, depth .22, promise .16,
   * contact .12, history .10, grade .08, collateral .08; ceiling ₱500,000):
   *
   * L2 — ₱16,000, 536 days, no contact channels, one prior write-off, never
   *      scored, unsecured:
   *        exposure   .24 × (16000/500000)      =  0.77
   *        depth      .22 × 1.0   (D_180_PLUS)  = 22.00
   *        promise    .16 × 0.5   (none on file)=  8.00
   *        contact    .12 × 0.5   (0 channels,
   *                                never contacted) =  6.00
   *        history    .10 × 1.0   (1 of 1 bad)  = 10.00
   *        grade      .08 × 0.5   (never scored)=  4.00
   *        collateral .08 × 0                   =  0.00
   *                                        total = 50.77  → HIGH
   *
   * L1 — ₱15,000, 135 days, phone+email, 1 of 2 promises broken, one prior
   *      CLOSED loan, tier F, unsecured, contacted 10 days ago:
   *        exposure   .24 × 0.03                =  0.72
   *        depth      .22 × 0.9   (D_121_180)   = 19.80
   *        promise    .16 × 0.5   (1 of 2 broken)=  8.00
   *        contact    .12 × (1×.5 + (10/14)×.5) = 10.29
   *        history    .10 × 0     (0 of 1 bad)  =  0.00
   *        grade      .08 × 1.0   (tier F)      =  8.00
   *        collateral .08 × 0                   =  0.00
   *                                        total = 46.81  → HIGH
   *
   * L3 — ₱24,000, 20 days, phone only, never contacted, no promises, no
   *      prior loans, tier A, secured ₱300,000:
   *        exposure   .24 × 0.048               =  1.15
   *        depth      .22 × 0.2   (D_1_30)      =  4.40
   *        promise    .16 × 0.5                 =  8.00
   *        contact    .12 × (.5×.5 + 1×.5)      =  9.00
   *        history    .10 × 0.5                 =  5.00
   *        grade      .08 × 0.1   (tier A)      =  0.80
   *        collateral .08 × 1.0   (12.5× cover) =  8.00
   *                                        total = 36.35  → MEDIUM
   *
   * Ranking: L2 (50.77) > L1 (46.81) > L3 (36.35).
   *
   * Note what that ordering is: the top account is the ancient, unreachable,
   * smallest-balance one. That is the linear-exposure limitation documented
   * in weights.ts, and it is CURRENT BEHAVIOUR — pinned here as-is. This
   * test exists to catch pagination silently reordering the queue, not to
   * endorse the ranking.
   */

  it("ranks the whole book by priority score, highest first", async () => {
    const { prisma } = book();
    const rows = await new CollectionsRepository(prisma).overdueQueue(AS_OF);

    expect(rows.map((r) => r.number)).toEqual([
      "LN-0002",
      "LN-0001",
      "LN-0003",
    ]);
    expect(rows.map((r) => r.priority.score)).toEqual([50.77, 46.81, 36.35]);
    expect(rows.map((r) => r.priority.band)).toEqual([
      "HIGH",
      "HIGH",
      "MEDIUM",
    ]);
    // Descending, with no ties to break here.
    const scores = rows.map((r) => r.priority.score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]!).toBeGreaterThan(scores[i]!);
    }
  });

  it("excludes loans with nothing past due", async () => {
    const { prisma } = book();
    const rows = await new CollectionsRepository(prisma).overdueQueue(AS_OF);
    // L4 is ACTIVE and open, but its only instalment is not yet due.
    expect(rows.map((r) => r.id)).not.toContain("loan-4");
    // L5 CLOSED and L6 WRITTEN_OFF are outside the status filter.
    expect(rows.map((r) => r.id)).not.toContain("loan-5");
    expect(rows.map((r) => r.id)).not.toContain("loan-6");
    expect(rows).toHaveLength(3);
  });

  it("derives the per-row figures a collector reads", async () => {
    const { prisma } = book();
    const rows = await new CollectionsRepository(prisma).overdueQueue(AS_OF);
    const byNumber = new Map(rows.map((r) => [r.number, r]));

    expect(byNumber.get("LN-0001")).toMatchObject({
      customerName: "Ana Reyes",
      customerCity: "Cebu City",
      customerProvince: "Cebu",
      daysOverdue: 135,
      outstanding: 15000,
      overdueCount: 2,
    });
    expect(byNumber.get("LN-0002")).toMatchObject({
      customerName: "Ben Cruz",
      customerCity: "Davao City",
      customerProvince: "Davao del Sur",
      daysOverdue: 536,
      outstanding: 16000,
      overdueCount: 2,
    });
    expect(byNumber.get("LN-0003")).toMatchObject({
      customerName: "Carla Diaz",
      daysOverdue: 20,
      outstanding: 24000,
      overdueCount: 1,
    });
  });

  it("carries the assignee, and null when nobody holds the account", async () => {
    const { prisma } = book();
    const rows = await new CollectionsRepository(prisma).overdueQueue(AS_OF);
    const byNumber = new Map(rows.map((r) => [r.number, r]));

    expect(byNumber.get("LN-0001")!.assignee).toEqual({
      collectorId: "col-1",
      collectorName: "Grace Lim",
      assignedAt: new Date("2026-06-01T00:00:00.000Z"),
      note: "Priority account",
    });
    expect(byNumber.get("LN-0002")!.assignee).toBeNull();
    expect(byNumber.get("LN-0003")!.assignee).toBeNull();
  });

  it("does not let a defaulted loan count as its own bad history", async () => {
    const { prisma } = book();
    const rows = await new CollectionsRepository(prisma).overdueQueue(AS_OF);
    const l2 = rows.find((r) => r.number === "LN-0002")!;

    // cus-2 owns L2 (DEFAULTED, on the queue) and L6 (WRITTEN_OFF, not on
    // it). Only L6 may count, so the history factor reads 1 of 1 — not 2.
    const history = l2.priority.factors.find(
      (f) => f.factorId === "repaymentHistory",
    )!;
    expect(history.source).toBe(
      "1 of 1 prior loan(s) defaulted or written off",
    );
    expect(history.points).toBe(10);
  });

  it("explains every row with the full factor breakdown", async () => {
    const { prisma } = book();
    const rows = await new CollectionsRepository(prisma).overdueQueue(AS_OF);

    for (const row of rows) {
      expect(row.priority.factors).toHaveLength(7);
      // The score is exactly the sum of the factor points it publishes —
      // the property that makes a queue position arguable.
      const summed = row.priority.factors.reduce((s, f) => s + f.points, 0);
      expect(Math.round(summed * 100) / 100).toBe(row.priority.score);
      expect(row.priority.missingFactors).toHaveLength(2);
    }
  });

  it("recommends an action and channel per row", async () => {
    const { prisma } = book();
    const rows = await new CollectionsRepository(prisma).overdueQueue(AS_OF);
    const byNumber = new Map(rows.map((r) => [r.number, r]));

    // 536 days, unsecured → legal referral, served in writing.
    expect(byNumber.get("LN-0002")!.priority).toMatchObject({
      agingBucket: "D_180_PLUS",
      action: "ESCALATE_LEGAL",
      channel: "LETTER",
    });
    // 135 days → final demand.
    expect(byNumber.get("LN-0001")!.priority).toMatchObject({
      agingBucket: "D_121_180",
      action: "FINAL_DEMAND",
      channel: "LETTER",
    });
    // 20 days → early arrears, cheapest channel that reaches them.
    expect(byNumber.get("LN-0003")!.priority).toMatchObject({
      agingBucket: "D_1_30",
      action: "SEND_REMINDER",
      channel: "SMS",
    });
  });

  it("narrows to one collector's book without changing the scores", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);
    const mine = await repo.overdueQueue(AS_OF, { collectorId: "col-1" });

    expect(mine.map((r) => r.number)).toEqual(["LN-0001"]);
    // Same score as in the full queue: a filter must not rescale anything.
    expect(mine[0]!.priority.score).toBe(46.81);
  });

  it("narrows to the unassigned hand-out pool", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);
    const pool = await repo.overdueQueue(AS_OF, { unassignedOnly: true });

    expect(pool.map((r) => r.number)).toEqual(["LN-0002", "LN-0003"]);
    expect(pool.map((r) => r.priority.score)).toEqual([50.77, 36.35]);
  });
});
