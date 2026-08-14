import type { PrismaClient } from "@loan/db";
import { describe, expect, it } from "vitest";

import { ReportsService } from "./reports.service";

/**
 * GOLDEN TESTS — the ECL movement report (`ReportsService`, "ecl-movement").
 *
 * Written against the implementation as it stands and committed passing
 * BEFORE any change, per §81. They pin what the report produces today,
 * including the two ways it can report a movement the general ledger
 * never booked.
 *
 * ── What the current implementation does, exactly ──────────────────────
 *
 *  1. Reads EVERY `EclRun` row whose `asOf` falls in [from, to],
 *     ordered by `asOf` ascending. No filter on whether the run posted.
 *  2. Derives `delta` by walking that sequence and subtracting the
 *     previous ROW's `totalEcl`, seeded at **0**.
 *  3. Emits `journalEntryId` straight off the row — which, since the
 *     double-post fix, is written only by the run that actually posted
 *     and is null on every re-run.
 *  4. Never reads the journal. Nothing in the report is sourced from the
 *     ledger, so nothing in it can be reconciled to the ledger.
 *
 * ── Defect 1: a re-run invents a movement that was never journalised ───
 *
 * A second run over an already-posted period recomputes and re-stages,
 * and books nothing — `ALREADY_POSTED`. But it still writes an `EclRun`
 * row, and step 2 subtracts it from its predecessor, so the report grows
 * a delta row for a movement the ledger does not contain. In the fixture
 * below that is the −100.00 on the June re-run.
 *
 * ── Defect 2: the first row in the window reports its whole level ──────
 *
 * `previousTotalEcl` is seeded at 0 rather than at the closing provision
 * of the period BEFORE the window, so the earliest row in any range
 * reports its entire provision as a movement. The fixture's May run
 * (700.00) sits outside the window, so June's first row claims a 780.00
 * movement against a ledger that booked 80.00.
 *
 * Both are the same failure: the report and the general ledger disagree,
 * and the report is what management reads.
 *
 * ── Fixture ────────────────────────────────────────────────────────────
 *
 * Runs, and what the ledger actually holds for each period:
 *
 *   MAY   2026-05-01..05-31  asOf 05-31        totalEcl 700.00
 *         posted je-0  → allowance +700.00   (first ever run)
 *   JUNE  2026-06-01..06-30  asOf 06-30 10:00  totalEcl 780.00
 *         posted je-1  → allowance  +80.00   (780 − 700)
 *   JUNE  2026-06-01..06-30  asOf 06-30 14:00  totalEcl 680.00   ← re-run
 *         posted NOTHING (ALREADY_POSTED); journalEntryId null
 *   JULY  2026-07-01..07-31  asOf 07-31        totalEcl 580.00
 *         posted je-2  → allowance −100.00   (580 − 680)
 *
 * Report window: 2026-06-01 → 2026-07-31, so MAY is outside it.
 *
 * Net ECL movement in the general ledger across that window:
 *   +80.00 − 100.00 = −20.00
 * The report's deltas today sum to +580.00.
 */

// ─── Fixture ────────────────────────────────────────────────────────────

interface FakeRun {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  asOf: Date;
  totalEad: string;
  totalEcl: string;
  stage1Count: number;
  stage2Count: number;
  stage3Count: number;
  stage1Ecl: string;
  stage2Ecl: string;
  stage3Ecl: string;
  journalEntryId: string | null;
}

interface FakeLine {
  code: string;
  debit: string;
  credit: string;
}

interface FakeEntry {
  id: string;
  source: string;
  sourceRefType: string | null;
  sourceRefId: string | null;
  reversedById: string | null;
  lines: FakeLine[];
}

const ALLOWANCE = "1190";
const IMPAIRMENT = "5050";

function utc(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
}

function run(
  id: string,
  period: [string, string],
  asOf: string,
  totalEcl: string,
  journalEntryId: string | null,
): FakeRun {
  return {
    id,
    periodStart: utc(period[0]),
    periodEnd: utc(period[1]),
    asOf: utc(asOf),
    totalEad: "17000.00",
    totalEcl,
    stage1Count: 1,
    stage2Count: 1,
    stage3Count: 1,
    stage1Ecl: "80.00",
    stage2Ecl: "500.00",
    stage3Ecl: "200.00",
    journalEntryId,
  };
}

/** An ECL provision movement as `eclProvisionEntry` builds it. */
function eclEntry(id: string, periodRef: string, delta: number): FakeEntry {
  const amount = Math.abs(delta).toFixed(2);
  return {
    id,
    source: "ECL_PROVISION",
    sourceRefType: "EclPeriod",
    sourceRefId: periodRef,
    reversedById: null,
    lines:
      delta > 0
        ? [
            { code: IMPAIRMENT, debit: amount, credit: "0.00" },
            { code: ALLOWANCE, debit: "0.00", credit: amount },
          ]
        : [
            { code: ALLOWANCE, debit: amount, credit: "0.00" },
            { code: IMPAIRMENT, debit: "0.00", credit: amount },
          ],
  };
}

function fixture() {
  const runs: FakeRun[] = [
    run(
      "run-may",
      ["2026-05-01", "2026-05-31"],
      "2026-05-31",
      "700.00",
      "je-0",
    ),
    run(
      "run-jun-1",
      ["2026-06-01", "2026-06-30"],
      "2026-06-30T10:00:00.000Z",
      "780.00",
      "je-1",
    ),
    run(
      "run-jun-2",
      ["2026-06-01", "2026-06-30"],
      "2026-06-30T14:00:00.000Z",
      "680.00",
      null,
    ),
    run(
      "run-jul",
      ["2026-07-01", "2026-07-31"],
      "2026-07-31",
      "580.00",
      "je-2",
    ),
  ];
  const entries: FakeEntry[] = [
    eclEntry("je-0", "2026-05-01:2026-05-31", 700),
    eclEntry("je-1", "2026-06-01:2026-06-30", 80),
    eclEntry("je-2", "2026-07-01:2026-07-31", -100),
  ];
  return { runs, entries };
}

/**
 * What the LEDGER says moved for a period — net credit on the allowance
 * account across that period's ECL entries. This is the number the
 * report has to agree with; it is computed here from the fixture's
 * journal, independently of anything the service does.
 */
function ledgerMovementFor(entries: FakeEntry[], periodRef: string): number {
  return +entries
    .filter(
      (e) =>
        e.source === "ECL_PROVISION" &&
        e.sourceRefId === periodRef &&
        e.reversedById === null,
    )
    .flatMap((e) => e.lines)
    .filter((l) => l.code === ALLOWANCE)
    .reduce((sum, l) => sum + Number(l.credit) - Number(l.debit), 0)
    .toFixed(2);
}

function fakeDb(runs: FakeRun[], entries: FakeEntry[]) {
  return {
    eclRun: {
      findMany: ({ where }: { where: { asOf: { gte: Date; lte: Date } } }) => {
        const { gte, lte } = where.asOf;
        return Promise.resolve(
          runs
            .filter((r) => r.asOf >= gte && r.asOf <= lte)
            .sort((a, b) => a.asOf.getTime() - b.asOf.getTime()),
        );
      },
      findFirst: ({
        where,
        orderBy,
      }: {
        where: { periodEnd: { lt: Date } };
        orderBy?: unknown;
      }) => {
        void orderBy;
        const prior = runs
          .filter((r) => r.periodEnd.getTime() < where.periodEnd.lt.getTime())
          .sort(
            (a, b) =>
              b.periodEnd.getTime() - a.periodEnd.getTime() ||
              b.asOf.getTime() - a.asOf.getTime(),
          );
        return Promise.resolve(prior[0] ?? null);
      },
    },
    journalEntry: {
      findMany: ({
        where,
      }: {
        where: { source: string; sourceRefId: { in: string[] } };
      }) =>
        Promise.resolve(
          entries.filter(
            (e) =>
              e.source === where.source &&
              where.sourceRefId.in.includes(e.sourceRefId ?? ""),
          ),
        ),
    },
  } as unknown as PrismaClient;
}

function service(runs: FakeRun[], entries: FakeEntry[]) {
  return new ReportsService(
    fakeDb(runs, entries),
    undefined as unknown as ConstructorParameters<typeof ReportsService>[1],
    undefined as unknown as ConstructorParameters<typeof ReportsService>[2],
  );
}

const WINDOW = { from: utc("2026-06-01"), to: utc("2026-07-31T23:59:59.999Z") };

// ─── Shape and identity ─────────────────────────────────────────────────

describe("ecl-movement report — shape", () => {
  it("names the file for the requested range", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );
    expect(bundle.filename).toBe("ecl-movement-2026-06-01_to_2026-07-31");
  });

  it("returns one row per EclRun in the window, ordered by asOf", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    // The May run is outside the window and is not a row.
    expect(bundle.rows.map((r) => r.runId)).toEqual([
      "run-jun-1",
      "run-jun-2",
      "run-jul",
    ]);
  });

  it("pins the level figures carried off each run row", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    expect(bundle.rows[0]).toMatchObject({
      runId: "run-jun-1",
      asOf: "2026-06-30",
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      totalEad: 17_000,
      stage1Ecl: 80,
      stage1Count: 1,
      stage2Ecl: 500,
      stage2Count: 1,
      stage3Ecl: 200,
      stage3Count: 1,
      totalEcl: 780,
    });
  });
});

// ─── The defects ────────────────────────────────────────────────────────

describe("ecl-movement report — deltas the ledger never booked", () => {
  /**
   * DEFECT 1. The June re-run booked nothing — it is the
   * `ALREADY_POSTED` path, and that is why its `journalEntryId` is null.
   * The report still gives it a movement row.
   *
   * This assertion is expected to change. It pins a defect: a −100.00
   * movement appears in a management report against a ledger that has
   * no such entry.
   */
  it("reports a −100.00 movement for a re-run that booked nothing", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const reRun = bundle.rows[1]!;
    expect(reRun.runId).toBe("run-jun-2");
    expect(reRun.delta).toBe(-100);
    // …and it plainly did not post: no journal link on the row.
    expect(reRun.journalEntryId).toBeNull();

    // The ledger booked +80.00 for June, once. Nothing booked −100.00.
    expect(ledgerMovementFor(entries, "2026-06-01:2026-06-30")).toBe(80);
  });

  /**
   * DEFECT 2. `previousTotalEcl` starts at 0, so the earliest row in the
   * range reports its whole closing provision as a movement — here
   * 780.00 against a ledger that booked 80.00, because the 700.00 it
   * built on was booked in May, outside the window.
   *
   * Also expected to change: the movement of a period does not depend
   * on which report range you asked for.
   */
  it("reports the first row's entire provision as its movement", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const june = bundle.rows[0]!;
    expect(june.totalEcl).toBe(780);
    expect(june.delta).toBe(780);

    // The ledger booked 80.00 for June — the movement from May's 700.00.
    expect(ledgerMovementFor(entries, "2026-06-01:2026-06-30")).toBe(80);
  });

  it("is range-dependent: the same run reports a different movement", async () => {
    const { runs, entries } = fixture();

    const wide = await service(runs, entries).generate("ecl-movement", {
      from: utc("2026-05-01"),
      to: utc("2026-07-31T23:59:59.999Z"),
    });
    const narrow = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    // With May in range, June's first row moves 80.00. Without it, 780.00.
    expect(wide.rows.find((r) => r.runId === "run-jun-1")!.delta).toBe(80);
    expect(narrow.rows.find((r) => r.runId === "run-jun-1")!.delta).toBe(780);
  });

  /**
   * The headline. Summing the report's movement column over the window
   * gives a number that is nowhere in the general ledger, and is wrong
   * by 600.00 — larger than the movement itself.
   */
  it("sums to 580.00 over a window in which the ledger moved −20.00", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const reported = bundle.rows.reduce(
      (sum, r) => sum + (r.delta as number),
      0,
    );
    expect(reported).toBe(580);

    const booked =
      ledgerMovementFor(entries, "2026-06-01:2026-06-30") +
      ledgerMovementFor(entries, "2026-07-01:2026-07-31");
    expect(booked).toBe(-20);

    expect(reported).not.toBe(booked);
  });

  it("carries no column sourced from the ledger at all", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    /*
     * `journalEntryId` is an EclRun COLUMN, not a ledger read — the
     * report never opens the journal, so there is nothing in it that
     * could be reconciled against what was actually booked.
     */
    expect(Object.keys(bundle.rows[0]!).sort()).toEqual([
      "asOf",
      "delta",
      "journalEntryId",
      "periodEnd",
      "periodStart",
      "runId",
      "stage1Count",
      "stage1Ecl",
      "stage2Count",
      "stage2Ecl",
      "stage3Count",
      "stage3Ecl",
      "totalEad",
      "totalEcl",
    ]);
  });
});
