import type { PrismaClient } from "@loan/db";
import { describe, expect, it } from "vitest";

import { ReportsService } from "./reports.service";

/**
 * GOLDEN TESTS — the ECL movement report (`ReportsService`, "ecl-movement").
 *
 * Committed passing against the UNMODIFIED report first, per §81, then
 * updated by the fix. Five assertions changed and every one of them had
 * pinned a defect; each carries a note saying what it used to say.
 *
 * ── What the implementation did BEFORE ─────────────────────────────────
 *
 *  1. Read EVERY `EclRun` row whose `asOf` falls in [from, to], ordered
 *     by `asOf` ascending. No filter on whether the run posted.
 *  2. Derived `delta` by walking that sequence and subtracting the
 *     previous ROW's `totalEcl`, seeded at **0**.
 *  3. Emitted `journalEntryId` straight off the row — which, since the
 *     double-post fix, is written only by the run that actually posted
 *     and is null on every re-run.
 *  4. Never read the journal, so nothing in the report could be
 *     reconciled to what was actually booked.
 *
 * ── Defect 1: a re-run invented a movement never journalised ───────────
 *
 * A second run over an already-posted period recomputes and re-stages,
 * and books nothing — `ALREADY_POSTED`. But it still writes an `EclRun`
 * row, and step 2 subtracted it from its predecessor, so the report grew
 * a delta row for a movement the ledger does not contain. In the fixture
 * below that was the −100.00 on the June re-run.
 *
 * ── Defect 2: the first row in the window reported its whole level ─────
 *
 * `previousTotalEcl` was seeded at 0 rather than at the closing
 * provision of the period BEFORE the window, so the earliest row in any
 * range reported its entire provision as a movement. The fixture's May
 * run (700.00) sits outside the window, so June's first row claimed a
 * 780.00 movement against a ledger that booked 80.00 — and the same
 * period moved by a different amount depending on the range requested.
 *
 * Both are the same failure: the report and the general ledger
 * disagreed, and the report is what management reads.
 *
 * ── What it does now ───────────────────────────────────────────────────
 *
 * Every run is still a row — dropping the unposted ones would make the
 * report agree with the ledger by hiding the disagreement, and the stage
 * splits live only on the run. Each row now carries `computedDelta`
 * (against the previous PERIOD's close, looked up outside the window
 * when needed), `bookedDelta` (read from the journal), `unbookedDelta`
 * (the gap), and `postedByThisRun`. `delta` is gone rather than
 * redefined. Summing `bookedDelta` over `postedByThisRun` rows gives the
 * ledger's own movement for the window.
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

/**
 * Enough of Prisma to drive the real `ReportsService`. Both `eclRun`
 * reads go through one `findMany`, discriminated the way Prisma would:
 * the window read filters on `asOf`, the baseline read on `periodEnd`.
 */
function fakeDb(runs: FakeRun[], entries: FakeEntry[]) {
  const queries: string[] = [];
  const client = {
    eclRun: {
      findMany: ({
        where,
        take,
      }: {
        where: { asOf?: { gte: Date; lte: Date }; periodEnd?: { lt: Date } };
        take?: number;
      }) => {
        if (where.asOf) {
          queries.push("window");
          const { gte, lte } = where.asOf;
          return Promise.resolve(
            runs
              .filter((r) => r.asOf >= gte && r.asOf <= lte)
              .sort((a, b) => a.asOf.getTime() - b.asOf.getTime()),
          );
        }
        queries.push("history");
        const cutoff = where.periodEnd!.lt.getTime();
        return Promise.resolve(
          runs
            .filter((r) => r.periodEnd.getTime() < cutoff)
            .sort(
              (a, b) =>
                b.periodEnd.getTime() - a.periodEnd.getTime() ||
                b.asOf.getTime() - a.asOf.getTime(),
            )
            .slice(0, take ?? runs.length),
        );
      },
    },
    journalEntry: {
      findMany: ({
        where,
      }: {
        where: {
          source: string;
          sourceRefType: string;
          sourceRefId: { in: string[] };
        };
      }) => {
        queries.push("ledger");
        return Promise.resolve(
          entries
            .filter(
              (e) =>
                e.source === where.source &&
                e.sourceRefType === where.sourceRefType &&
                where.sourceRefId.in.includes(e.sourceRefId ?? ""),
            )
            // Reshaped to the `select` the service asks for.
            .map((e) => ({
              id: e.id,
              sourceRefId: e.sourceRefId,
              reversedById: e.reversedById,
              lines: e.lines.map((l) => ({
                debit: l.debit,
                credit: l.credit,
                account: { code: l.code },
              })),
            })),
        );
      },
    },
  };
  return { prisma: client as unknown as PrismaClient, queries };
}

function service(runs: FakeRun[], entries: FakeEntry[]) {
  const db = fakeDb(runs, entries);
  return Object.assign(
    new ReportsService(
      db.prisma,
      undefined as unknown as ConstructorParameters<typeof ReportsService>[1],
      undefined as unknown as ConstructorParameters<typeof ReportsService>[2],
    ),
    { queries: db.queries },
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

describe("ecl-movement report — the report now ties to the ledger", () => {
  /**
   * DEFECT 1, closed. The June re-run booked nothing — it is the
   * `ALREADY_POSTED` path, and that is why its `EclRun.journalEntryId`
   * is null.
   *
   * The row used to assert `delta === -100`: a movement in a management
   * report against a ledger with no such entry. It now reports the
   * −100.00 as UNBOOKED, which is the honest statement of the same
   * fact — the recomputation says June should close at 680.00, the
   * books carry 780.00, and 100.00 of release has not been journalised.
   */
  it("shows a re-run's movement as unbooked rather than as a movement", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const reRun = bundle.rows[1]!;
    expect(reRun.runId).toBe("run-jun-2");
    // Against May's 700.00 close, this computation implies −20.00…
    expect(reRun.computedDelta).toBe(-20);
    // …the ledger booked +80.00 for June…
    expect(reRun.bookedDelta).toBe(80);
    // …so 100.00 of release is not in the books.
    expect(reRun.unbookedDelta).toBe(-100);

    // It did not post, and says so — but still points at June's entry.
    expect(reRun.postedByThisRun).toBe(false);
    expect(reRun.journalEntryId).toBe("je-1");

    // Agrees with the journal, computed independently of the service.
    expect(reRun.bookedDelta).toBe(
      ledgerMovementFor(entries, "2026-06-01:2026-06-30"),
    );
  });

  /**
   * DEFECT 2, closed. The baseline is the closing provision of the
   * previous PERIOD, fetched from outside the report window when it has
   * to be, instead of a zero seed. June's first row moved 80.00 from
   * May's 700.00 — which is what the ledger booked.
   */
  it("baselines the first row on the period before the window", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const june = bundle.rows[0]!;
    expect(june.totalEcl).toBe(780);
    expect(june.computedDelta).toBe(80); // was 780 — the whole provision
    expect(june.bookedDelta).toBe(80);
    expect(june.unbookedDelta).toBe(0);
    expect(june.postedByThisRun).toBe(true);
    expect(june.journalEntryId).toBe("je-1");
  });

  it("is range-independent: a period moves by the same amount either way", async () => {
    const { runs, entries } = fixture();

    const wide = await service(runs, entries).generate("ecl-movement", {
      from: utc("2026-05-01"),
      to: utc("2026-07-31T23:59:59.999Z"),
    });
    const narrow = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    // Was 80.00 with May in range and 780.00 without it.
    const inWide = wide.rows.find((r) => r.runId === "run-jun-1")!;
    const inNarrow = narrow.rows.find((r) => r.runId === "run-jun-1")!;
    expect(inWide.computedDelta).toBe(80);
    expect(inNarrow.computedDelta).toBe(80);
    expect(inWide.bookedDelta).toBe(inNarrow.bookedDelta);
  });

  /**
   * The headline, inverted. The booked column now sums to exactly what
   * the general ledger moved over the window — and the rows that did
   * not post are excluded from that sum by `postedByThisRun`, so a
   * period that was run twice cannot be counted twice.
   *
   * The old `delta` column summed to 580.00 against a ledger that moved
   * −20.00.
   */
  it("sums to the ledger's own movement over the window", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const booked = bundle.rows
      .filter((r) => r.postedByThisRun)
      .reduce((sum, r) => sum + (r.bookedDelta as number), 0);

    const inLedger =
      ledgerMovementFor(entries, "2026-06-01:2026-06-30") +
      ledgerMovementFor(entries, "2026-07-01:2026-07-31");

    expect(booked).toBe(-20);
    expect(booked).toBe(inLedger);
  });

  it("July's movement is measured against June's latest recomputation", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const july = bundle.rows[2]!;
    expect(july.runId).toBe("run-jul");
    // 580.00 against June's closing 680.00 — the re-run, not the 780.00
    // first cut, because a period closes at what it was last computed to.
    expect(july.computedDelta).toBe(-100);
    expect(july.bookedDelta).toBe(-100);
    expect(july.unbookedDelta).toBe(0);
    expect(july.journalEntryId).toBe("je-2");
  });

  it("carries the ledger columns the reconciliation needs", async () => {
    const { runs, entries } = fixture();
    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    // `delta` is gone rather than redefined — it was neither the
    // computed movement nor the booked one.
    expect(Object.keys(bundle.rows[0]!).sort()).toEqual([
      "asOf",
      "bookedDelta",
      "computedDelta",
      "journalEntryId",
      "periodEnd",
      "periodStart",
      "postedByThisRun",
      "runId",
      "stage1Count",
      "stage1Ecl",
      "stage2Count",
      "stage2Ecl",
      "stage3Count",
      "stage3Ecl",
      "totalEad",
      "totalEcl",
      "unbookedDelta",
    ]);
  });
});

// ─── A reversed period ──────────────────────────────────────────────────

describe("ecl-movement report — a period whose entry was reversed", () => {
  /**
   * §12 says posted history is corrected by reversal. A reversed entry
   * booked nothing on net, so the period's whole movement is unbooked
   * until something is posted in its place — and the report has to say
   * so rather than keep crediting the reversed figure.
   */
  it("reports the whole movement as unbooked once the entry is reversed", async () => {
    const { runs, entries } = fixture();
    entries.find((e) => e.id === "je-1")!.reversedById = "je-rev";

    const bundle = await service(runs, entries).generate(
      "ecl-movement",
      WINDOW,
    );

    const june = bundle.rows[0]!;
    expect(june.computedDelta).toBe(80);
    expect(june.bookedDelta).toBe(0);
    expect(june.unbookedDelta).toBe(80);
    // The entry is still named — a reader needs to find the reversal.
    expect(june.journalEntryId).toBe("je-1");
  });
});

// ─── Empty window ───────────────────────────────────────────────────────

describe("ecl-movement report — no runs in the window", () => {
  it("returns no rows, and does not go looking for a baseline", async () => {
    const { runs, entries } = fixture();
    const svc = service(runs, entries);
    const bundle = await svc.generate("ecl-movement", {
      from: utc("2026-01-01"),
      to: utc("2026-01-31T23:59:59.999Z"),
    });

    expect(bundle.rows).toEqual([]);
    // Neither the history nor the ledger is queried for an empty window.
    expect(svc.queries).toEqual(["window"]);
  });

  it("reads the history and the ledger once each for a populated window", async () => {
    const { runs, entries } = fixture();
    const svc = service(runs, entries);
    await svc.generate("ecl-movement", WINDOW);

    // Three rows, three queries — not one per row.
    expect(svc.queries).toEqual(["window", "history", "ledger"]);
  });
});
