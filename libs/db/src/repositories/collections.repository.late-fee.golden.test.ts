import type { JournalEntry } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  type FakeSchedule,
  type LedgerFixture,
  inMemoryLedger,
} from "../testing/in-memory-ledger";
import { CollectionsRepository } from "./collections.repository";

/**
 * GOLDEN TESTS — nightly late-fee accrual (`accrueLateFees`).
 *
 * Written against the CURRENT implementation and committed passing BEFORE
 * the F1 refactor (docs/modernization/query-performance.md), per §81.
 *
 * What the current implementation computes, exactly:
 *
 *  1. Selects every `LoanSchedule` with `paidInFullAt IS NULL`, `dueDate <
 *     asOf`, on a loan whose status is ACTIVE or DISBURSED.
 *  2. Derives a `dayKey` from `asOf` in **local** time
 *     (`getFullYear`/`getMonth`/`getDate`), so the idempotency key is the
 *     calendar day of the machine running the job.
 *  3. For each installment, in the order the query returned them:
 *     a. Picks the policy: the loan's product policy when a product row
 *        exists, otherwise the policy passed by the caller.
 *     b. `targetFee = lateFeeFor(installment, asOf, policy)` — the total fee
 *        that *should* be on the books, capped, rounded to 2dp.
 *     c. `targetFee <= 0` → skipped, no query issued.
 *     d. Otherwise reads every `LATE_FEE_ACCRUAL` / `LoanScheduleLateFee`
 *        journal entry whose `sourceRefId` starts with `"<scheduleId>:"`, and
 *        sums the credit on the line whose account code is `4100` (Fee
 *        Income). An entry with no 4100 line contributes 0.
 *     e. `delta = round2(targetFee - accrued)`; `delta <= 0` → skipped.
 *     f. Otherwise builds a `lateFeeAccrualEntry` for `delta` keyed
 *        `"<scheduleId>:<dayKey>"` and calls `postIfAbsent`.
 *  4. `posted` counts `created === true`; everything else increments
 *     `skipped` — including a `postIfAbsent` that found today's entry
 *     already there.
 *
 * These tests pin the posted amounts, the source refs, and the two counters.
 * They say nothing about how many round trips it takes to read the accrued
 * amounts, which is exactly the thing F1 is free to change.
 *
 * Dates are built from LOCAL components on purpose. `dayKey` is local, so a
 * UTC literal would make the expected `sourceRefId` depend on the timezone of
 * whoever runs the suite.
 */

/** Local midnight, so `dayKey` is stable in any timezone. */
function localDate(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d);
}

const AS_OF = localDate(2026, 6, 30);
const DAY_KEY = "2026-06-30";

const FEE_INCOME = "acc-fee";
const RECEIVABLE = "acc-ar";

function schedule(
  id: string,
  installmentNo: number,
  due: Date,
  totalDue: string,
  product: FakeSchedule["loan"]["product"] = null,
): FakeSchedule {
  return {
    id,
    installmentNo,
    dueDate: due,
    totalDue,
    paidInFullAt: null,
    loan: {
      id: `loan-${id}`,
      number: `LN-${id}`,
      status: "ACTIVE",
      product,
    },
  };
}

/** A prior accrual entry for `scheduleId` crediting `feeAmount` to 4100. */
function accrual(
  id: string,
  scheduleId: string,
  day: string,
  feeAmount: string,
): { entry: LedgerFixture["entries"][number]; lines: LedgerFixture["lines"] } {
  return {
    entry: {
      id,
      number: `JE-2026-${id}`,
      entryDate: localDate(2026, 6, 1),
      source: "LATE_FEE_ACCRUAL",
      sourceRefType: "LoanScheduleLateFee",
      sourceRefId: `${scheduleId}:${day}`,
      memo: null,
    },
    lines: [
      {
        id: `${id}-dr`,
        entryId: id,
        accountId: RECEIVABLE,
        debit: feeAmount,
        credit: "0.00",
      },
      {
        id: `${id}-cr`,
        entryId: id,
        accountId: FEE_INCOME,
        debit: "0.00",
        credit: feeAmount,
      },
    ],
  };
}

/*
 * A: 1,000.00 due 2026-06-01. 29 days over, 3 grace, 26 billable.
 *    raw 260.00 vs cap 100.00 → target 100.00. Nothing accrued → post 100.00.
 * B:   500.00 due 2026-06-25. 5 over, 2 billable. raw 10.00, cap 50.00
 *    → target 10.00. 4.00 already accrued → post 6.00.
 * C:   800.00 due 2026-06-28. 2 over, 0 billable → target 0 → skipped, and
 *    no accrual lookup is issued at all.
 * D: 2,000.00 due 2026-05-01. 60 over, 57 billable. raw 1,140.00, cap 200.00
 *    → target 200.00. Exactly 200.00 accrued across two entries → delta 0
 *    → skipped.
 * E: 1,200.00 due 2026-06-10 with a PRODUCT policy (0.5%/day, 5% cap, no
 *    grace). 20 over, 20 billable. raw 120.00 vs cap 60.00 → target 60.00.
 *    Nothing accrued → post 60.00. Pins that the product policy wins over
 *    the caller-supplied one.
 * F:   333.33 due 2026-06-20. 10 over, 7 billable. raw 23.3331 → 23.33.
 *    23.00 accrued → delta round2(23.33 - 23.00) → 0.33. Exercises the
 *    float subtraction that only round2 rescues.
 * G:   600.00 due 2026-06-05. 25 over, 22 billable. raw 132.00, cap 60.00
 *    → target 60.00. One prior entry exists for this schedule but carries NO
 *    4100 line, so `accrued` is 0 and the full 60.00 is posted. `postIfAbsent`
 *    reports created:false for it — today's entry is already there — so it
 *    lands in `skipped`, not `posted`.
 */
const SCHEDULES: FakeSchedule[] = [
  schedule("A", 1, localDate(2026, 6, 1), "1000.00"),
  schedule("B", 2, localDate(2026, 6, 25), "500.00"),
  schedule("C", 3, localDate(2026, 6, 28), "800.00"),
  schedule("D", 4, localDate(2026, 5, 1), "2000.00"),
  schedule("E", 5, localDate(2026, 6, 10), "1200.00", {
    lateFeeDailyRate: "0.0050",
    lateFeeCapFraction: "0.0500",
    lateFeeGraceDays: 0,
  }),
  schedule("F", 6, localDate(2026, 6, 20), "333.33"),
  schedule("G", 7, localDate(2026, 6, 5), "600.00"),
];

const PRIOR = [
  accrual("P1", "B", "2026-06-28", "4.00"),
  accrual("P2", "D", "2026-06-28", "150.00"),
  accrual("P3", "D", "2026-06-29", "50.00"),
  accrual("P4", "F", "2026-06-29", "23.00"),
];

const FIXTURE: LedgerFixture = {
  accounts: [
    {
      id: RECEIVABLE,
      code: "1100",
      name: "Loans Receivable",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
    {
      id: FEE_INCOME,
      code: "4100",
      name: "Fee Income",
      type: "INCOME",
      normalBalance: "CREDIT",
    },
    {
      id: "acc-other",
      code: "2000",
      name: "Accounts Payable",
      type: "LIABILITY",
      normalBalance: "CREDIT",
    },
  ],
  entries: [
    ...PRIOR.map((p) => p.entry),
    // G's prior entry: a LATE_FEE_ACCRUAL with no Fee Income line.
    {
      id: "P5",
      number: "JE-2026-P5",
      entryDate: localDate(2026, 6, 2),
      source: "LATE_FEE_ACCRUAL",
      sourceRefType: "LoanScheduleLateFee",
      sourceRefId: "G:2026-06-02",
      memo: null,
    },
    // A decoy: right prefix shape, wrong source. Must not be counted.
    {
      id: "P6",
      number: "JE-2026-P6",
      entryDate: localDate(2026, 6, 3),
      source: "MANUAL",
      sourceRefType: "LoanScheduleLateFee",
      sourceRefId: "A:2026-06-03",
      memo: null,
    },
  ],
  lines: [
    ...PRIOR.flatMap((p) => p.lines),
    {
      id: "P5-dr",
      entryId: "P5",
      accountId: RECEIVABLE,
      debit: "25.00",
      credit: "0.00",
    },
    {
      id: "P5-cr",
      entryId: "P5",
      accountId: "acc-other",
      debit: "0.00",
      credit: "25.00",
    },
    {
      id: "P6-dr",
      entryId: "P6",
      accountId: RECEIVABLE,
      debit: "999.00",
      credit: "0.00",
    },
    {
      id: "P6-cr",
      entryId: "P6",
      accountId: FEE_INCOME,
      debit: "0.00",
      credit: "999.00",
    },
  ],
  schedules: SCHEDULES,
};

interface PostedCall {
  sourceRefId: string | undefined;
  memo: string | undefined;
  debit: number | undefined;
  credit: number | undefined;
}

/**
 * Builds the repository with `postIfAbsent` replaced by a recorder. The real
 * one is covered by accounting.repository.idempotency.test.ts; here we only
 * need to know what the accrual asked it to post.
 */
function harness(): {
  repo: CollectionsRepository;
  posted: PostedCall[];
} {
  const { prisma } = inMemoryLedger(FIXTURE);
  const repo = new CollectionsRepository(prisma);
  const posted: PostedCall[] = [];

  const accounting = (
    repo as unknown as {
      accounting: {
        postIfAbsent: (
          input: {
            sourceRefId?: string;
            memo?: string;
            lines: Array<{
              accountCode: string;
              debit: number;
              credit: number;
            }>;
          },
          opts: unknown,
        ) => Promise<{ entry: JournalEntry; created: boolean }>;
      };
    }
  ).accounting;

  accounting.postIfAbsent = (input) => {
    const dr = input.lines.find((l) => l.accountCode === "1100");
    const cr = input.lines.find((l) => l.accountCode === "4100");
    posted.push({
      sourceRefId: input.sourceRefId,
      memo: input.memo,
      debit: dr?.debit,
      credit: cr?.credit,
    });
    // G's entry for today already exists — the idempotency path.
    const created = input.sourceRefId !== `G:${DAY_KEY}`;
    return Promise.resolve({
      entry: { id: `posted-${posted.length}` } as JournalEntry,
      created,
    });
  };

  return { repo, posted };
}

describe("GOLDEN — accrueLateFees", () => {
  it("posts exactly these entries, in this order, for these amounts", async () => {
    const { repo, posted } = harness();

    await repo.accrueLateFees(AS_OF, "user-1");

    expect(posted).toEqual([
      {
        sourceRefId: `A:${DAY_KEY}`,
        memo: `Late fee LN-A #1 (${DAY_KEY})`,
        debit: 100,
        credit: 100,
      },
      {
        sourceRefId: `B:${DAY_KEY}`,
        memo: `Late fee LN-B #2 (${DAY_KEY})`,
        debit: 6,
        credit: 6,
      },
      {
        sourceRefId: `E:${DAY_KEY}`,
        memo: `Late fee LN-E #5 (${DAY_KEY})`,
        debit: 60,
        credit: 60,
      },
      {
        sourceRefId: `F:${DAY_KEY}`,
        memo: `Late fee LN-F #6 (${DAY_KEY})`,
        debit: 0.33,
        credit: 0.33,
      },
      {
        sourceRefId: `G:${DAY_KEY}`,
        memo: `Late fee LN-G #7 (${DAY_KEY})`,
        debit: 60,
        credit: 60,
      },
    ]);
  });

  it("returns these posted/skipped counters", async () => {
    const { repo } = harness();
    // A, B, E, F created. C target 0, D delta 0, G already posted today.
    expect(await repo.accrueLateFees(AS_OF, "user-1")).toEqual({
      posted: 4,
      skipped: 3,
    });
  });

  it("lets the product policy override the caller-supplied one", async () => {
    const { repo, posted } = harness();
    // A 10%/day, 100% cap, no grace policy would give E a far larger fee if
    // the caller's policy were used; the product's 0.5%/5% must win.
    await repo.accrueLateFees(AS_OF, "user-1", {
      dailyRate: 0.1,
      capFraction: 1,
      graceDays: 0,
    });
    expect(posted.find((p) => p.sourceRefId === `E:${DAY_KEY}`)?.credit).toBe(
      60,
    );
  });

  it("applies the caller-supplied policy where there is no product", async () => {
    const { repo, posted } = harness();
    // A: 1,000.00, 29 days over, no grace, 2%/day capped at 50% → cap 500.00
    // beats raw 580.00.
    await repo.accrueLateFees(AS_OF, "user-1", {
      dailyRate: 0.02,
      capFraction: 0.5,
      graceDays: 0,
    });
    expect(posted.find((p) => p.sourceRefId === `A:${DAY_KEY}`)?.credit).toBe(
      500,
    );
  });

  it("counts only LATE_FEE_ACCRUAL entries towards what is already accrued", async () => {
    // Schedule A has a MANUAL entry with sourceRefId "A:2026-06-03" crediting
    // 999.00 to Fee Income. If the source filter were dropped, A's delta would
    // go negative and nothing would post.
    const { repo, posted } = harness();
    await repo.accrueLateFees(AS_OF, "user-1");
    expect(posted.find((p) => p.sourceRefId === `A:${DAY_KEY}`)?.credit).toBe(
      100,
    );
  });

  it("treats an accrual entry with no Fee Income line as contributing zero", async () => {
    // G's prior entry credits 2000, not 4100.
    const { repo, posted } = harness();
    await repo.accrueLateFees(AS_OF, "user-1");
    expect(posted.find((p) => p.sourceRefId === `G:${DAY_KEY}`)?.credit).toBe(
      60,
    );
  });

  it("posts nothing when every installment is already fully accrued", async () => {
    const { prisma } = inMemoryLedger({
      ...FIXTURE,
      schedules: [SCHEDULES[3]!], // D — exactly 200.00 accrued against a 200.00 cap
    });
    const repo = new CollectionsRepository(prisma);
    let calls = 0;
    (
      repo as unknown as { accounting: { postIfAbsent: () => unknown } }
    ).accounting.postIfAbsent = () => {
      calls += 1;
      return Promise.resolve({ entry: {} as JournalEntry, created: true });
    };

    expect(await repo.accrueLateFees(AS_OF, "user-1")).toEqual({
      posted: 0,
      skipped: 1,
    });
    expect(calls).toBe(0);
  });

  it("posts nothing when there are no overdue installments", async () => {
    const { prisma } = inMemoryLedger({ ...FIXTURE, schedules: [] });
    const repo = new CollectionsRepository(prisma);
    expect(await repo.accrueLateFees(AS_OF, "user-1")).toEqual({
      posted: 0,
      skipped: 0,
    });
  });
});
