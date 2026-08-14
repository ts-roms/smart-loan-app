import { describe, expect, it } from "vitest";

import {
  type LedgerFixture,
  inMemoryLedger,
} from "../testing/in-memory-ledger";
import { LoanRepository } from "./loan.repository";

/**
 * GOLDEN TESTS — `accruedPenaltiesFor` (loan.repository.ts).
 *
 * The read-path sibling of the F1 accrual loop, and until now untested
 * despite three API consumers (the loans route, demand letters, and
 * repossession). Written against the CURRENT implementation and committed
 * passing BEFORE it is touched, per §81.
 *
 * What the current implementation computes, exactly:
 *
 *   Resolves the loan by id or number, takes every one of its schedule ids,
 *   and — if there is at least one — reads every `LATE_FEE_ACCRUAL` /
 *   `LoanScheduleLateFee` journal entry whose `sourceRefId` starts with any
 *   of `"<scheduleId>:"` (an `OR` of N `startsWith` clauses). For each entry
 *   it takes the credit on the line whose account code is `4100`, defaulting
 *   to 0 when the entry has no such line, and sums them in float.
 *
 *   Separately sums `PenaltyWaiver.waivedAmount` for the loan, also in float.
 *
 *   Returns all three figures rounded: `originalPenalty`, `waivedToDate`, and
 *   `outstanding = round2(originalPenalty - waivedToDate)` — note the
 *   subtraction happens on the UNROUNDED sums.
 *
 *   A loan with no schedule rows short-circuits to three zeroes without
 *   querying journal entries at all.
 *
 * These pin the amounts. They say nothing about whether the entries are
 * fetched in one query or several, which is what the refactor may change.
 */

const FEE_INCOME = "acc-fee";
const RECEIVABLE = "acc-ar";
const OTHER = "acc-other";

/** A real uuid, so `idOrNumberWhere` routes it to `{id}` rather than `{number}`. */
const L1_ID = "11111111-1111-4111-8111-111111111111";

/** A LATE_FEE_ACCRUAL entry crediting `fee` to 4100 for `scheduleId`. */
function accrual(
  id: string,
  scheduleId: string,
  day: string,
  fee: string,
): { entry: LedgerFixture["entries"][number]; lines: LedgerFixture["lines"] } {
  return {
    entry: {
      id,
      number: `JE-2026-${id}`,
      entryDate: new Date("2026-06-01T00:00:00.000Z"),
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
        debit: fee,
        credit: "0.00",
      },
      {
        id: `${id}-cr`,
        entryId: id,
        accountId: FEE_INCOME,
        debit: "0.00",
        credit: fee,
      },
    ],
  };
}

/*
 * Loan L1 has three instalments. Accruals:
 *   s1: 10.00 + 20.50   = 30.50
 *   s2: 33.33           = 33.33
 *   s3: none
 * plus an entry on s3 with no 4100 line at all (contributes 0), and a decoy
 * MANUAL entry on s1 that must not be counted.
 * Total originalPenalty = 63.83. Waivers 12.50 + 1.33 = 13.83.
 * Outstanding = 50.00.
 *
 * Loan L2 exists but has no schedule rows — the short-circuit case.
 * Loan L3 has schedules but no accruals and no waivers.
 */
const ACCRUALS = [
  accrual("A1", "s1", "2026-06-10", "10.00"),
  accrual("A2", "s1", "2026-06-11", "20.50"),
  accrual("A3", "s2", "2026-06-10", "33.33"),
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
      id: OTHER,
      code: "2000",
      name: "Accounts Payable",
      type: "LIABILITY",
      normalBalance: "CREDIT",
    },
  ],
  entries: [
    ...ACCRUALS.map((a) => a.entry),
    // Right source, right prefix, but no Fee Income line → contributes 0.
    {
      id: "A4",
      number: "JE-2026-A4",
      entryDate: new Date("2026-06-12T00:00:00.000Z"),
      source: "LATE_FEE_ACCRUAL",
      sourceRefType: "LoanScheduleLateFee",
      sourceRefId: "s3:2026-06-12",
      memo: null,
    },
    // Decoy: correct prefix, wrong source. Must not be counted.
    {
      id: "A5",
      number: "JE-2026-A5",
      entryDate: new Date("2026-06-13T00:00:00.000Z"),
      source: "MANUAL",
      sourceRefType: "LoanScheduleLateFee",
      sourceRefId: "s1:2026-06-13",
      memo: null,
    },
    // Belongs to a schedule of a different loan entirely.
    ...[accrual("A6", "z9", "2026-06-14", "500.00").entry],
  ],
  lines: [
    ...ACCRUALS.flatMap((a) => a.lines),
    {
      id: "A4-dr",
      entryId: "A4",
      accountId: RECEIVABLE,
      debit: "7.00",
      credit: "0.00",
    },
    {
      id: "A4-cr",
      entryId: "A4",
      accountId: OTHER,
      debit: "0.00",
      credit: "7.00",
    },
    {
      id: "A5-dr",
      entryId: "A5",
      accountId: RECEIVABLE,
      debit: "999.00",
      credit: "0.00",
    },
    {
      id: "A5-cr",
      entryId: "A5",
      accountId: FEE_INCOME,
      debit: "0.00",
      credit: "999.00",
    },
    ...accrual("A6", "z9", "2026-06-14", "500.00").lines,
  ],
  loans: [
    { id: L1_ID, number: "LN-0001", scheduleIds: ["s1", "s2", "s3"] },
    { id: "L2", number: "LN-0002", scheduleIds: [] },
    { id: "L3", number: "LN-0003", scheduleIds: ["s7", "s8"] },
  ],
  waivers: [
    { loanId: L1_ID, waivedAmount: "12.50" },
    { loanId: L1_ID, waivedAmount: "1.33" },
  ],
};

function repo(): LoanRepository {
  const { prisma } = inMemoryLedger(FIXTURE);
  return new LoanRepository(prisma);
}

describe("GOLDEN — accruedPenaltiesFor", () => {
  it("sums accruals across every schedule of the loan, net of waivers", async () => {
    expect(await repo().accruedPenaltiesFor("LN-0001")).toEqual({
      originalPenalty: 63.83,
      waivedToDate: 13.83,
      outstanding: 50,
    });
  });

  it("resolves by id as well as by number", async () => {
    // `idOrNumberWhere` routes a uuid to {id} and anything else to {number};
    // both must reach the same loan.
    expect((await repo().accruedPenaltiesFor(L1_ID)).originalPenalty).toBe(
      63.83,
    );
  });

  it("returns three zeroes for a loan with no schedule rows", async () => {
    expect(await repo().accruedPenaltiesFor("LN-0002")).toEqual({
      originalPenalty: 0,
      waivedToDate: 0,
      outstanding: 0,
    });
  });

  it("returns zeroes for a loan whose schedules have no accruals", async () => {
    expect(await repo().accruedPenaltiesFor("LN-0003")).toEqual({
      originalPenalty: 0,
      waivedToDate: 0,
      outstanding: 0,
    });
  });

  it("ignores entries belonging to another loan's schedules", async () => {
    // Schedule z9 carries a 500.00 accrual and must not leak into L1.
    expect((await repo().accruedPenaltiesFor("LN-0001")).originalPenalty).toBe(
      63.83,
    );
  });

  it("counts only LATE_FEE_ACCRUAL entries", async () => {
    // The MANUAL decoy on s1 credits 999.00 to Fee Income.
    expect((await repo().accruedPenaltiesFor("LN-0001")).originalPenalty).toBe(
      63.83,
    );
  });

  it("treats an accrual entry with no Fee Income line as zero", async () => {
    // A4 is on s3 and debits Receivable 7.00 with no 4100 credit.
    expect((await repo().accruedPenaltiesFor("LN-0001")).originalPenalty).toBe(
      63.83,
    );
  });

  it("throws when the loan does not exist", async () => {
    await expect(repo().accruedPenaltiesFor("LN-NOPE")).rejects.toThrow(
      /Loan not found/,
    );
  });
});
