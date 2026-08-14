import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { EclRepository } from "./ecl.repository";

/**
 * GOLDEN TESTS — IFRS 9 ECL run (`EclRepository.run`).
 *
 * Written against the CURRENT implementation and committed passing BEFORE
 * the re-run double-post fix, per §81. The figures pinned here are the
 * output of one run; they must be identical after the change. The only
 * assertions expected to move are the ones describing what a SECOND run
 * for an ALREADY-POSTED period does — those are marked "CURRENT
 * BEHAVIOUR (DEFECT)" so the change is visible in the diff rather than
 * asserted in prose.
 *
 * ── What the current implementation does, exactly ──────────────────────
 *
 *  1. Reads every LoanApplication whose status is DISBURSED, ACTIVE or
 *     DEFAULTED. Terminal states (CLOSED, REJECTED, CANCELLED,
 *     RESTRUCTURED, WRITTEN_OFF) are out of scope.
 *  2. Per loan, `asOf` defaulting to `periodEnd`:
 *     a. DPD = floor((asOf − oldest unpaid installment's dueDate) / 1 day),
 *        counting only installments with `paidInFullAt IS NULL` and
 *        `dueDate < asOf`. No overdue installment → DPD 0.
 *     b. Stage: ≥90 → STAGE_3, ≥30 → STAGE_2, else STAGE_1. (The "one-way
 *        door" / cure period described in the file header is NOT
 *        implemented — staging is purely DPD-driven, every run.)
 *     c. PD = product.eclPd12m for Stage 1, product.eclPdLifetime for
 *        Stages 2 and 3. LGD = product.eclLgd.
 *     d. EAD = Σ (principalDue − principalPaid) over UNPAID installments
 *        only — including instalments not yet due.
 *     e. ECL = round2(EAD × PD × LGD).
 *     f. Writes eclStage / eclProvision / eclComputedAt back onto the loan.
 *  3. Totals are accumulated from the UNROUNDED ead/ecl per loan and
 *     rounded once at the end.
 *  4. Delta = round2(totalEcl − previous.totalEcl), where `previous` is the
 *     most recent EclRun with `periodEnd < input.periodEnd`. Strictly
 *     less-than: a run for a period that already has one does NOT see it.
 *  5. Creates a NEW EclRun row, then builds the journal entry from that
 *     row's freshly-minted id and calls `postIfAbsent`.
 *  6. Entry direction: delta > 0 → Dr 5050 Impairment Loss / Cr 1190
 *     Allowance for Doubtful. delta < 0 → the reverse. |delta| < 0.01 →
 *     no entry at all. No entry either when `computedById` is absent.
 *
 * ── The defect these tests pin ─────────────────────────────────────────
 *
 * Step 5 derives the journal idempotency key from a row step 5 has just
 * created, so the key is new on every call and the unique index on
 * (source, sourceRefType, sourceRefId) can never fire. Re-running a period
 * books the movement again. Each entry balances on its own, so the trial
 * balance still ties and no downstream check sees it.
 *
 * ── Fixture ────────────────────────────────────────────────────────────
 *
 * One product: PD(12m) 2%, PD(lifetime) 25%, LGD 40%.
 *
 *   LN-A  ACTIVE     no overdue instalment          → Stage 1
 *         EAD 5,000 + 5,000 = 10,000.00
 *         ECL 10,000 × 0.02 × 0.40 =     80.00
 *   LN-B  ACTIVE     due 2026-05-16, 45 DPD         → Stage 2
 *         EAD (2,000 − 500) + 3,500 = 5,000.00
 *         ECL  5,000 × 0.25 × 0.40 =    500.00
 *   LN-C  DEFAULTED  due 2026-03-02, 120 DPD        → Stage 3
 *         EAD 2,000.00
 *         ECL  2,000 × 0.25 × 0.40 =    200.00
 *   LN-D  CLOSED     — out of scope, never read
 *
 *   Totals: EAD 17,000.00, ECL 780.00
 *
 * Dates are UTC literals and DPD is derived from absolute milliseconds, so
 * the arithmetic is DST- and timezone-independent.
 */

// ─── Fixture types ──────────────────────────────────────────────────────

interface FakeInstallment {
  id: string;
  dueDate: Date;
  paidInFullAt: Date | null;
  principalDue: string;
  principalPaid: string;
}

interface FakeLoan {
  id: string;
  number: string;
  status: string;
  product: {
    eclPd12m: string;
    eclPdLifetime: string;
    eclLgd: string;
  };
  schedule: FakeInstallment[];
}

interface PostedLine {
  code: string;
  debit: number;
  credit: number;
  memo?: string;
}

interface PostedEntry {
  id: string;
  number: string;
  entryDate: Date;
  memo: string | null;
  source: string;
  sourceRefType: string | null;
  sourceRefId: string | null;
  lines: PostedLine[];
}

const IMPAIRMENT_LOSS = "5050";
const ALLOWANCE = "1190";

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function instalment(
  id: string,
  due: string,
  principalDue: string,
  principalPaid = "0.00",
  paidInFullAt: string | null = null,
): FakeInstallment {
  return {
    id,
    dueDate: utc(due),
    paidInFullAt: paidInFullAt ? utc(paidInFullAt) : null,
    principalDue,
    principalPaid,
  };
}

const PRODUCT = {
  eclPd12m: "0.0200",
  eclPdLifetime: "0.2500",
  eclLgd: "0.4000",
};

function fixtureLoans(): FakeLoan[] {
  return [
    {
      id: "loan-a",
      number: "LN-A",
      status: "ACTIVE",
      product: { ...PRODUCT },
      schedule: [
        // Settled — excluded from both EAD and the DPD scan.
        instalment("a1", "2026-04-15", "5000.00", "5000.00", "2026-04-14"),
        instalment("a2", "2026-07-15", "5000.00"),
        instalment("a3", "2026-08-15", "5000.00"),
      ],
    },
    {
      id: "loan-b",
      number: "LN-B",
      status: "ACTIVE",
      product: { ...PRODUCT },
      schedule: [
        // Part-paid principal: EAD counts the remaining 1,500 only.
        instalment("b1", "2026-05-16", "2000.00", "500.00"),
        instalment("b2", "2026-07-16", "3500.00"),
      ],
    },
    {
      id: "loan-c",
      number: "LN-C",
      status: "DEFAULTED",
      product: { ...PRODUCT },
      schedule: [instalment("c1", "2026-03-02", "2000.00")],
    },
    {
      id: "loan-d",
      number: "LN-D",
      status: "CLOSED",
      product: { ...PRODUCT },
      schedule: [instalment("d1", "2026-01-10", "9999.00")],
    },
  ];
}

// ─── Prisma stand-in ────────────────────────────────────────────────────

/**
 * Enough of Prisma to drive the real `EclRepository.run` and the real
 * `AccountingRepository.postEntry`/`postIfAbsent` underneath it — no
 * method on either class is stubbed.
 *
 * `journalEntry.create` enforces the unique index on
 * (source, sourceRefType, sourceRefId) by throwing P2002, because that
 * index is the whole mechanism under test: a key that repeats must be
 * rejected by the database, not by a lookup that raced.
 */
function fakeDb(loans: FakeLoan[]) {
  const eclRuns: Array<Record<string, unknown> & { id: string }> = [];
  const entries: PostedEntry[] = [];
  const loanWrites: Array<{ id: string; data: Record<string, unknown> }> = [];
  const accounts = [
    { id: "acc-5050", code: IMPAIRMENT_LOSS, active: true },
    { id: "acc-1190", code: ALLOWANCE, active: true },
  ];
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));
  let runSeq = 0;
  let entrySeq = 0;

  function uniqueViolation(): Error & { code: string } {
    const err = new Error(
      "Unique constraint failed on the fields: (`source`,`sourceRefType`,`sourceRefId`)",
    ) as Error & { code: string };
    err.code = "P2002";
    return err;
  }

  const client = {
    loanApplication: {
      findMany: ({ where }: { where: { status: { in: string[] } } }) =>
        Promise.resolve(
          loans.filter((l) => where.status.in.includes(l.status)),
        ),
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        loanWrites.push({ id: where.id, data });
        return Promise.resolve({ id: where.id });
      },
    },

    eclRun: {
      findFirst: ({ where }: { where: { periodEnd: { lt: Date } } }) => {
        const cutoff = where.periodEnd.lt.getTime();
        const prior = eclRuns
          .filter((r) => (r.periodEnd as Date).getTime() < cutoff)
          .sort(
            (a, b) =>
              (b.periodEnd as Date).getTime() - (a.periodEnd as Date).getTime(),
          );
        return Promise.resolve(prior[0] ?? null);
      },
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `run-${++runSeq}`, journalEntryId: null, ...data };
        eclRuns.push(row);
        return Promise.resolve(row);
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = eclRuns.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    },

    account: {
      findMany: ({ where }: { where: { code: { in: string[] } } }) =>
        Promise.resolve(accounts.filter((a) => where.code.in.includes(a.code))),
    },

    accountingPeriod: {
      upsert: ({
        where,
      }: {
        where: { year_month: { year: number; month: number } };
      }) => {
        const { year, month } = where.year_month;
        return Promise.resolve({
          id: `period-${year}-${month}`,
          year,
          month,
          status: "OPEN",
        });
      },
    },

    journalEntry: {
      // Two callers, two `where` shapes: the idempotency lookup
      // (findBySourceRef) and the entry-number allocator.
      findFirst: ({
        where,
      }: {
        where: {
          source?: string;
          sourceRefType?: string | null;
          sourceRefId?: string;
          entryDate?: { gte: Date; lt: Date };
        };
      }) => {
        if (where.sourceRefId !== undefined) {
          const found = entries.find(
            (e) =>
              e.source === where.source &&
              e.sourceRefType === (where.sourceRefType ?? null) &&
              e.sourceRefId === where.sourceRefId,
          );
          return Promise.resolve(found ?? null);
        }
        const { gte, lt } = where.entryDate!;
        const inYear = entries
          .filter((e) => e.entryDate >= gte && e.entryDate < lt)
          .sort((a, b) => (a.number < b.number ? 1 : -1));
        return Promise.resolve(inYear[0] ?? null);
      },
      create: ({ data }: { data: Record<string, never> }) => {
        const d = data as unknown as {
          number: string;
          entryDate: Date;
          memo?: string;
          source: string;
          sourceRefType?: string;
          sourceRefId?: string;
          lines: {
            create: Array<{
              accountId: string;
              debit: number;
              credit: number;
              memo?: string;
            }>;
          };
        };
        const sourceRefType = d.sourceRefType ?? null;
        const sourceRefId = d.sourceRefId ?? null;
        if (
          sourceRefId !== null &&
          entries.some(
            (e) =>
              e.source === d.source &&
              e.sourceRefType === sourceRefType &&
              e.sourceRefId === sourceRefId,
          )
        ) {
          throw uniqueViolation();
        }
        const entry: PostedEntry = {
          id: `je-${++entrySeq}`,
          number: d.number,
          entryDate: d.entryDate,
          memo: d.memo ?? null,
          source: d.source,
          sourceRefType,
          sourceRefId,
          lines: d.lines.create.map((l) => ({
            code: codeOf.get(l.accountId)!,
            debit: l.debit,
            credit: l.credit,
            memo: l.memo,
          })),
        };
        entries.push(entry);
        return Promise.resolve(entry);
      },
    },
  };

  return {
    prisma: client as unknown as PrismaClient,
    loans,
    eclRuns,
    entries,
    loanWrites,
    /** Net movement on 1190 across every entry posted so far. */
    allowanceBuilt() {
      return +entries
        .flatMap((e) => e.lines)
        .filter((l) => l.code === ALLOWANCE)
        .reduce((sum, l) => sum + l.credit - l.debit, 0)
        .toFixed(2);
    },
    eclEntries() {
      return entries.filter((e) => e.source === "ECL_PROVISION");
    },
  };
}

const JUNE = { periodStart: utc("2026-06-01"), periodEnd: utc("2026-06-30") };
const JULY = { periodStart: utc("2026-07-01"), periodEnd: utc("2026-07-31") };
const AUGUST = { periodStart: utc("2026-08-01"), periodEnd: utc("2026-08-31") };

// ─── Golden figures — one run ───────────────────────────────────────────

describe("EclRepository.run — golden figures for a single run", () => {
  it("pins the per-loan staging, EAD and ECL", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    const result = await repo.run({ ...JUNE, computedById: "user-1" });

    expect(result.perLoan).toEqual([
      {
        loanId: "loan-a",
        number: "LN-A",
        dpd: 0,
        stage: "STAGE_1",
        ead: 10_000,
        ecl: 80,
      },
      {
        loanId: "loan-b",
        number: "LN-B",
        dpd: 45,
        stage: "STAGE_2",
        ead: 5_000,
        ecl: 500,
      },
      {
        loanId: "loan-c",
        number: "LN-C",
        dpd: 120,
        stage: "STAGE_3",
        ead: 2_000,
        ecl: 200,
      },
    ]);
    // LN-D is CLOSED — a terminal state carries no provision.
    expect(result.perLoan.map((l) => l.number)).not.toContain("LN-D");
  });

  it("pins the portfolio totals and the stage buckets", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    const result = await repo.run({ ...JUNE, computedById: "user-1" });

    expect(result.totalEad).toBe(17_000);
    expect(result.totalEcl).toBe(780);
    expect(result.byStage).toEqual({
      STAGE_1: { count: 1, ecl: 80 },
      STAGE_2: { count: 1, ecl: 500 },
      STAGE_3: { count: 1, ecl: 200 },
    });
  });

  it("pins the movement: a first-ever run books the whole provision", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    const result = await repo.run({ ...JUNE, computedById: "user-1" });

    // No prior run, so the delta is the entire closing provision.
    expect(result.delta).toBe(780);
    expect(result.journalEntryId).toBe("je-1");
  });

  it("pins the journal lines and the direction of a build", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    await repo.run({ ...JUNE, computedById: "user-1" });

    expect(db.eclEntries()).toHaveLength(1);
    const entry = db.eclEntries()[0]!;
    expect(entry.source).toBe("ECL_PROVISION");
    expect(entry.entryDate).toEqual(utc("2026-06-30"));
    expect(entry.memo).toBe("ECL movement for 2026-06-01 → 2026-06-30");
    expect(entry.lines).toEqual([
      {
        code: IMPAIRMENT_LOSS,
        debit: 780,
        credit: 0,
        memo: "ECL increase",
      },
      {
        code: ALLOWANCE,
        debit: 0,
        credit: 780,
        memo: "ECL allowance build",
      },
    ]);
    expect(db.allowanceBuilt()).toBe(780);
  });

  it("persists the stage and provision back onto each loan", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    await repo.run({ ...JUNE, computedById: "user-1" });

    expect(db.loanWrites).toEqual([
      {
        id: "loan-a",
        data: {
          eclStage: "STAGE_1",
          eclProvision: 80,
          eclComputedAt: utc("2026-06-30"),
        },
      },
      {
        id: "loan-b",
        data: {
          eclStage: "STAGE_2",
          eclProvision: 500,
          eclComputedAt: utc("2026-06-30"),
        },
      },
      {
        id: "loan-c",
        data: {
          eclStage: "STAGE_3",
          eclProvision: 200,
          eclComputedAt: utc("2026-06-30"),
        },
      },
    ]);
  });

  it("computes and stores the run, but books nothing, without a computedById", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    const result = await repo.run(JUNE);

    expect(result.totalEcl).toBe(780);
    expect(result.delta).toBe(780);
    expect(result.journalEntryId).toBeNull();
    expect(db.entries).toHaveLength(0);
  });
});

// ─── Golden figures — successive periods ────────────────────────────────

describe("EclRepository.run — successive periods", () => {
  /**
   * Between June and July, LN-C's only instalment is settled: its EAD
   * falls to zero, it leaves Stage 3, and the portfolio provision drops
   * 780.00 → 580.00. The July run must book the 200.00 RELEASE, not the
   * new level.
   */
  function settleLoanC(db: ReturnType<typeof fakeDb>) {
    const c = db.loans.find((l) => l.id === "loan-c")!;
    c.schedule[0]!.paidInFullAt = utc("2026-07-05");
    c.schedule[0]!.principalPaid = "2000.00";
  }

  it("books only the period-on-period movement, in the right direction", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    const june = await repo.run({ ...JUNE, computedById: "user-1" });
    settleLoanC(db);
    const july = await repo.run({ ...JULY, computedById: "user-1" });

    expect(june.totalEcl).toBe(780);
    expect(july.totalEcl).toBe(580);
    expect(july.delta).toBe(-200);

    // Two genuinely different periods, two entries.
    expect(db.eclEntries()).toHaveLength(2);
    expect(db.eclEntries()[1]!.lines).toEqual([
      {
        code: ALLOWANCE,
        debit: 200,
        credit: 0,
        memo: "ECL allowance release",
      },
      {
        code: IMPAIRMENT_LOSS,
        debit: 0,
        credit: 200,
        memo: "ECL write-back",
      },
    ]);
    // Allowance now stands at the new provision level, reached in two moves.
    expect(db.allowanceBuilt()).toBe(580);
  });

  it("re-stages LN-C to Stage 1 once its arrears clear", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    await repo.run({ ...JUNE, computedById: "user-1" });
    settleLoanC(db);
    const july = await repo.run({ ...JULY, computedById: "user-1" });

    const c = july.perLoan.find((l) => l.number === "LN-C")!;
    expect(c).toEqual({
      loanId: "loan-c",
      number: "LN-C",
      dpd: 0,
      stage: "STAGE_1",
      ead: 0,
      ecl: 0,
    });
    // LN-B's arrears keep ageing: 2026-05-16 → 2026-07-31 is 76 days.
    expect(july.perLoan.find((l) => l.number === "LN-B")!.dpd).toBe(76);
  });

  it("posts nothing for a period whose delta rounds to zero", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    await repo.run({ ...JUNE, computedById: "user-1" });
    settleLoanC(db);
    await repo.run({ ...JULY, computedById: "user-1" });

    /*
     * A later period re-cut at the SAME as-of date — a period close
     * being re-struck after July's books were already provisioned.
     * `asOf` overrides `periodEnd` for the computation, so every loan
     * stages exactly as it did in July and the provision is unmoved.
     *
     * It has to be pinned this way: arrears age on their own. Left to
     * default to periodEnd 2026-08-31, LN-A's 2026-07-15 instalment is
     * 47 days down (Stage 2) and LN-B's is 107 (Stage 3), which is a
     * 920.00 build, not a flat period.
     */
    const august = await repo.run({
      ...AUGUST,
      asOf: utc("2026-07-31"),
      computedById: "user-1",
    });

    expect(august.totalEcl).toBe(580);
    expect(august.delta).toBe(0);
    expect(august.journalEntryId).toBeNull();
    // The run itself is still recorded — only the posting is skipped.
    expect(db.eclEntries()).toHaveLength(2);
    expect(db.eclRuns).toHaveLength(3);
    expect(db.allowanceBuilt()).toBe(580);
  });
});

// ─── Re-running a period that is already posted ─────────────────────────

describe("EclRepository.run — re-running an already-posted period", () => {
  /**
   * CURRENT BEHAVIOUR (DEFECT). The journal idempotency key is
   * `EclRun.id`, minted by the same call that posts, so it is new every
   * time and the unique index on (source, sourceRefType, sourceRefId)
   * never fires. Re-running June books the 780.00 movement a second
   * time: the allowance ends at 1,560.00 for a movement of 780.00, and
   * because each entry balances internally the trial balance still ties.
   *
   * The delta does not reset either — `previous` is the newest run with
   * `periodEnd < input.periodEnd`, and the run just written has
   * `periodEnd == input.periodEnd`, so the second call cannot see it and
   * recomputes the same 780.00 against the same empty history.
   */
  it("books the movement a second time", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    const first = await repo.run({ ...JUNE, computedById: "user-1" });
    const second = await repo.run({ ...JUNE, computedById: "user-1" });

    expect(first.delta).toBe(780);
    expect(second.delta).toBe(780);

    expect(db.eclEntries()).toHaveLength(2);
    expect(second.journalEntryId).toBe("je-2");
    expect(second.journalEntryId).not.toBe(first.journalEntryId);

    // The number that matters: 1,560.00 of allowance for a 780.00 movement.
    expect(db.allowanceBuilt()).toBe(1_560);
  });

  it("keys each entry on the run row it just created, so no two keys collide", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    await repo.run({ ...JUNE, computedById: "user-1" });
    await repo.run({ ...JUNE, computedById: "user-1" });

    const [one, two] = db.eclEntries();
    expect(one!.sourceRefType).toBe("EclRun");
    expect(two!.sourceRefType).toBe("EclRun");
    expect(one!.sourceRefId).toBe("run-1");
    expect(two!.sourceRefId).toBe("run-2");
    // Two EclRun rows for one period, each claiming its own posting.
    expect(db.eclRuns).toHaveLength(2);
    expect(db.eclRuns[0]!.journalEntryId).toBe("je-1");
    expect(db.eclRuns[1]!.journalEntryId).toBe("je-2");
  });

  it("books again on every further re-run, without bound", async () => {
    const db = fakeDb(fixtureLoans());
    const repo = new EclRepository(db.prisma);

    for (let i = 0; i < 4; i++) {
      await repo.run({ ...JUNE, computedById: "user-1" });
    }

    expect(db.eclEntries()).toHaveLength(4);
    expect(db.allowanceBuilt()).toBe(3_120);
  });
});
