import { describe, expect, it } from "vitest";

import {
  type BookFixture,
  type BookLoan,
  inMemoryBook,
} from "../testing/in-memory-book";
import { AccountingRepository } from "./accounting.repository";
import { CollectionsRepository } from "./collections.repository";

/**
 * The NEW behaviour introduced by the F4 refactor: bounded responses over
 * an unchanged whole-book computation.
 *
 * whole-book-reads.golden.test.ts already proves the numbers did not move.
 * What is proved here is the thing that would make those numbers useless
 * even if they were right — that a page is a window onto the same globally
 * ranked list, and not a locally re-ranked subset. The single most
 * important assertion in this file is that page 1 ++ page 2 ++ … equals
 * the whole ranking, in order.
 *
 * A book of 24 overdue loans, paged 5 at a time, so several boundaries are
 * crossed and the last page is deliberately short.
 */

const AS_OF = new Date("2026-06-30T00:00:00.000Z");

/**
 * Balances are all different so the priority scores are all different and
 * the ranking is a strict order — a tie would let a reordering bug hide.
 * Areas repeat so the area filter has something to select on.
 */
const AREAS = [
  { city: "Cebu City", province: "Cebu" },
  { city: "Davao City", province: "Davao del Sur" },
  { city: "Manila", province: "Metro Manila" },
];

function makeBook(loanCount: number): BookFixture {
  const customers = Array.from({ length: loanCount }, (_, i) => ({
    id: `cus-${i}`,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    city: AREAS[i % AREAS.length]!.city,
    province: AREAS[i % AREAS.length]!.province,
    phone: `+63 917 000 ${String(i).padStart(4, "0")}`,
    secondaryPhone: null,
    email: null,
    creditTier: null,
  }));

  const loans: BookLoan[] = Array.from({ length: loanCount }, (_, i) => {
    // Distinct balances → distinct exposure → distinct scores.
    const total = (1000 + i * 137).toFixed(2);
    return {
      id: `loan-${String(i).padStart(3, "0")}`,
      number: `LN-${String(i).padStart(4, "0")}`,
      customerId: `cus-${i}`,
      productCode: "SALARY",
      principal: total,
      status: "ACTIVE",
      disbursedAt: new Date("2025-01-01T00:00:00.000Z"),
      closedAt: null,
      writtenOffAt: null,
      schedule: [
        {
          id: `sch-${String(i).padStart(3, "0")}`,
          installmentNo: 1,
          // Staggered so days-overdue and therefore band varies too.
          dueDate: new Date(Date.UTC(2026, 0, 1 + (i % 5) * 30, 0, 0, 0, 0)),
          principalDue: (Number(total) * 0.6).toFixed(2),
          interestDue: (Number(total) * 0.4).toFixed(2),
          totalDue: total,
          principalPaid: "0.00",
          interestPaid: "0.00",
          paidInFullAt: null,
        },
      ],
      assignment: null,
      promises: [],
      notes: [],
    };
  });

  return { customers, loans };
}

const LOAN_COUNT = 24;
const FIXTURE = makeBook(LOAN_COUNT);
const book = () => inMemoryBook(FIXTURE);

// ─── The queue ─────────────────────────────────────────────────────────

describe("overdueQueuePage — a window onto the global ranking", () => {
  it("pages concatenate back into the whole ranking, in order", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);

    const whole = await repo.overdueQueue(AS_OF);
    expect(whole).toHaveLength(LOAN_COUNT);

    const paged: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await repo.overdueQueuePage(
        AS_OF,
        {},
        { page, pageSize: 5 },
      );
      paged.push(...result.rows.map((r) => r.number));
    }

    // The property the whole design rests on: paging is a window, not a
    // re-rank. If a page were scored among itself this would fail.
    expect(paged).toEqual(whole.map((r) => r.number));
  });

  it("keeps each row's score identical to its score in the whole queue", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);

    const whole = await repo.overdueQueue(AS_OF);
    const scoreOf = new Map(whole.map((r) => [r.number, r.priority.score]));

    const page3 = await repo.overdueQueuePage(
      AS_OF,
      {},
      { page: 3, pageSize: 5 },
    );
    expect(page3.rows).toHaveLength(5);
    for (const row of page3.rows) {
      expect(row.priority.score).toBe(scoreOf.get(row.number));
    }
    // And they are the 11th–15th ranked accounts, not the top 5 of a subset.
    expect(page3.rows.map((r) => r.number)).toEqual(
      whole.slice(10, 15).map((r) => r.number),
    );
  });

  it("reports the whole queue's size, not the page's", async () => {
    const { prisma } = book();
    const result = await new CollectionsRepository(prisma).overdueQueuePage(
      AS_OF,
      {},
      { page: 1, pageSize: 5 },
    );
    expect(result.rows).toHaveLength(5);
    expect(result.total).toBe(LOAN_COUNT);
    expect(result.totalPages).toBe(5); // 24 over 5
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(5);
  });

  it("serves a short last page and an empty page past the end", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);

    const last = await repo.overdueQueuePage(
      AS_OF,
      {},
      { page: 5, pageSize: 5 },
    );
    expect(last.rows).toHaveLength(4); // 24 = 5+5+5+5+4

    const past = await repo.overdueQueuePage(
      AS_OF,
      {},
      { page: 99, pageSize: 5 },
    );
    expect(past.rows).toEqual([]);
    // The count survives, so a UI can send the operator back somewhere real.
    expect(past.total).toBe(LOAN_COUNT);
  });

  it("clamps nonsense page params rather than rejecting them", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);

    const zero = await repo.overdueQueuePage(
      AS_OF,
      {},
      { page: 0, pageSize: 5 },
    );
    expect(zero.page).toBe(1);

    const huge = await repo.overdueQueuePage(
      AS_OF,
      {},
      { page: 1, pageSize: 100_000 },
    );
    expect(huge.pageSize).toBe(200); // QUEUE_PAGING max
  });

  it("defaults to a page, not to the whole book", async () => {
    // The point of the change: an unparameterised request must not ship
    // every delinquent account in the book.
    const big = makeBook(120);
    const { prisma } = inMemoryBook(big);
    const result = await new CollectionsRepository(prisma).overdueQueuePage(
      AS_OF,
    );
    expect(result.rows).toHaveLength(50); // QUEUE_PAGING default
    expect(result.total).toBe(120);
  });
});

describe("overdueQueue — area filtering happens in SQL", () => {
  it("narrows to a province across the whole book, not just a page", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);

    const cebu = await repo.overdueQueue(AS_OF, { province: "Cebu" });
    expect(cebu.length).toBe(8); // 24 loans over 3 areas
    expect(cebu.every((r) => r.customerProvince === "Cebu")).toBe(true);

    // Ranking within the filtered set is the same relative order as in the
    // whole book — filtering must not rescale anything.
    const whole = await repo.overdueQueue(AS_OF);
    const wholeOrder = whole
      .filter((r) => r.customerProvince === "Cebu")
      .map((r) => r.number);
    expect(cebu.map((r) => r.number)).toEqual(wholeOrder);
  });

  it("matches area case-insensitively, as the delinquency export does", async () => {
    const { prisma } = book();
    const repo = new CollectionsRepository(prisma);
    const lower = await repo.overdueQueue(AS_OF, { province: "cebu" });
    const exact = await repo.overdueQueue(AS_OF, { province: "Cebu" });
    expect(lower.map((r) => r.number)).toEqual(exact.map((r) => r.number));
  });

  it("pages a filtered queue over the filtered total", async () => {
    const { prisma } = book();
    const result = await new CollectionsRepository(prisma).overdueQueuePage(
      AS_OF,
      { city: "Manila" },
      { page: 1, pageSize: 3 },
    );
    expect(result.total).toBe(8);
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((r) => r.customerCity === "Manila")).toBe(true);
  });
});

describe("overdueQueuePage — the area facets", () => {
  it("offers every area in the queue, not just the ones on a page", async () => {
    const { prisma } = book();
    const result = await new CollectionsRepository(prisma).overdueQueuePage(
      AS_OF,
      {},
      { page: 1, pageSize: 3 },
    );
    // Page 1 holds three accounts; the control still offers all three areas.
    expect(result.rows).toHaveLength(3);
    expect(result.areas.provinces).toEqual([
      "Cebu",
      "Davao del Sur",
      "Metro Manila",
    ]);
    expect(result.areas.cities).toEqual(["Cebu City", "Davao City", "Manila"]);
  });

  it("still offers the others once one is picked", async () => {
    const { prisma } = book();
    const result = await new CollectionsRepository(prisma).overdueQueuePage(
      AS_OF,
      { province: "Cebu" },
    );
    // Having chosen Cebu, the control must not collapse to Cebu only —
    // otherwise the filter is a one-way door.
    expect(result.areas.provinces).toEqual([
      "Cebu",
      "Davao del Sur",
      "Metro Manila",
    ]);
    expect(result.total).toBe(8);
    expect(result.rows.every((r) => r.customerProvince === "Cebu")).toBe(true);
  });
});

// ─── The aging report ──────────────────────────────────────────────────

describe("loanPortfolioAging — paged rows over whole-book totals", () => {
  it("computes the band totals over the whole book on every page", async () => {
    const { prisma } = book();
    const repo = new AccountingRepository(prisma);

    const page1 = await repo.loanPortfolioAging(AS_OF, {
      page: 1,
      pageSize: 5,
    });
    const page4 = await repo.loanPortfolioAging(AS_OF, {
      page: 4,
      pageSize: 5,
    });
    const unpaged = await repo.loanPortfolioAging(AS_OF);

    // The whole point: the totals are the same on every page, and the same
    // as they were before pagination existed.
    expect(page1.totals).toEqual(unpaged.totals);
    expect(page4.totals).toEqual(unpaged.totals);
    expect(page1.totalOutstanding).toBe(unpaged.totalOutstanding);
    expect(page4.totalOutstanding).toBe(unpaged.totalOutstanding);

    // And they still describe the whole book, not the page.
    const sumOfBands = Object.values(page1.totals).reduce((s, v) => s + v, 0);
    expect(sumOfBands).toBe(page1.totalOutstanding);
  });

  it("reports the loan count as total, which is what the dashboard reads", async () => {
    const { prisma } = book();
    const result = await new AccountingRepository(prisma).loanPortfolioAging(
      AS_OF,
      { page: 1, pageSize: 5 },
    );
    expect(result.rows).toHaveLength(5);
    // `rows.length` is 5; the active-loan count is 24. The dashboard KPI
    // reads `total` for this reason.
    expect(result.total).toBe(LOAN_COUNT);
    expect(result.totalPages).toBe(5);
  });

  it("pages concatenate back into the whole row list, in order", async () => {
    const { prisma } = book();
    const repo = new AccountingRepository(prisma);

    const unpaged = await repo.loanPortfolioAging(AS_OF);
    const paged: string[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const result = await repo.loanPortfolioAging(AS_OF, {
        page,
        pageSize: 5,
      });
      paged.push(...result.rows.map((r) => r.loanNumber));
    }
    expect(paged).toEqual(unpaged.rows.map((r) => r.loanNumber));
  });

  it("keeps every loan in its band regardless of which page it lands on", async () => {
    const { prisma } = book();
    const repo = new AccountingRepository(prisma);

    const unpaged = await repo.loanPortfolioAging(AS_OF);
    const bandOf = new Map(unpaged.rows.map((r) => [r.loanNumber, r.bucket]));

    for (let page = 1; page <= 5; page += 1) {
      const result = await repo.loanPortfolioAging(AS_OF, {
        page,
        pageSize: 5,
      });
      for (const row of result.rows) {
        expect(row.bucket).toBe(bandOf.get(row.loanNumber));
      }
    }
  });
});
