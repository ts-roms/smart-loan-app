import { eclPeriodRef } from "@loan/accounting";
import { todayLocalISO } from "@loan/shared-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EclService } from "./ecl.service";

/**
 * GOLDEN TESTS — ECL period defaulting (`EclService.run`).
 *
 * Committed passing against the UNMODIFIED service first, per §81, then
 * updated by the fix. Six assertions changed and every one of them had
 * pinned a defect; each carries a CHANGED note saying what it used to
 * say and why that was wrong. The figures are pinned in
 * libs/db/src/repositories/ecl.repository.golden.test.ts and none of
 * them moved — see `passes asOf EXPLICITLY` for the reason.
 *
 * ── What the implementation did BEFORE ─────────────────────────────────
 *
 * With neither `periodStart` nor `periodEnd` supplied (the only way the
 * UI ever calls it — `POST /ecl/runs` has no body schema and the page
 * sends `{}`):
 *
 *   periodEnd   = `new Date()` — the INSTANT the request landed,
 *                 hours/minutes/seconds and all.
 *   periodStart = `new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1)`
 *                 — LOCAL midnight on the first of the LOCAL month.
 *   asOf        = not passed at all, so `EclRepository.run` defaulted it
 *                 to `periodEnd`, i.e. the same instant.
 *
 * `asOf` is what feeds DPD → staging → the ECL figures. `periodStart`
 * and `periodEnd` additionally feed `eclPeriodRef`, which is the journal
 * entry's idempotency key and is stringified with
 * `toISOString().slice(0, 10)` — a **UTC** calendar date.
 *
 * ── Defect 1: the key was derived from an instant, not a date ──────────
 *
 * Because `periodEnd` was an instant and the key takes its UTC date, two
 * runs on the same LOCAL day landed on different keys as soon as they
 * fell either side of UTC midnight. `postIfAbsent` then had nothing to
 * collide with and the movement booked a second time — the exact
 * double-post that keying on the period was meant to close.
 *
 * In Manila (UTC+8) UTC midnight is 08:00 local, so every local day was
 * split in two: a run at 07:00 keyed to yesterday's date, a run at 09:00
 * to today's. That is most of a working day, not an edge case.
 *
 * `same-local-day instants straddling UTC midnight …` below is the
 * assertion that pinned it, and the one that flipped.
 *
 * ── Defect 2: the default periodStart rendered as the WRONG MONTH ──────
 *
 * `new Date(y, m, 1)` is local midnight. Rendered back out as a UTC
 * date by `eclPeriodRef`, a host east of UTC gives the last day of the
 * PREVIOUS month: in Manila `new Date(2026, 7, 1)` is
 * `2026-07-31T16:00:00Z`, so the stored key and the entry memo both said
 * "2026-07-31" for a run the operator asked for on 1 August. The key is
 * immutable stored data, and it was not even stable across deployments —
 * the same request keyed differently on a UTC host and a Manila one.
 * The explicit-window path had the same bug and is fixed with it.
 *
 * ── How these stay host-timezone-independent ───────────────────────────
 *
 * The suite must mean the same thing wherever it runs, so nothing here
 * hard-codes Manila. Expectations are built from `todayLocalISO` and
 * from the host's own UTC offset; the straddling-instants pair is
 * derived at runtime and skipped on a UTC host, where local and UTC
 * midnight coincide and the defect could never have shown. This host
 * runs at UTC+8, so that pair resolves to 07:00 and 09:00 local.
 *
 * ── What is deliberately NOT asserted here ─────────────────────────────
 *
 * No ECL figure. The service does no arithmetic — it picks a window and
 * hands it to `EclRepository.run`, whose figures are pinned by
 * libs/db/src/repositories/ecl.repository.golden.test.ts. What these
 * tests pin is the window, and `asOf` within it, precisely because
 * `asOf` is the input the figures hang off: anything that moves `asOf`
 * moves DPD, staging and every ECL number, and these assertions are how
 * we can tell whether it did.
 */

// ─── Test doubles ───────────────────────────────────────────────────────

interface CapturedRun {
  periodStart: Date;
  periodEnd: Date;
  asOf?: Date;
  computedById?: string;
  notes?: string;
}

const RESULT = {
  id: "run-1",
  totalEad: 17_000,
  totalEcl: 780,
  byStage: {
    STAGE_1: { count: 1, ecl: 80 },
    STAGE_2: { count: 1, ecl: 500 },
    STAGE_3: { count: 1, ecl: 200 },
  },
  perLoan: [],
  delta: 780,
  journalEntryId: "je-1",
  posting: "POSTED" as const,
};

function harness() {
  const calls: CapturedRun[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const repo = {
    list: () => Promise.resolve([]),
    run: (input: CapturedRun) => {
      calls.push(input);
      return Promise.resolve(RESULT);
    },
  };
  const audit = {
    record: (event: Record<string, unknown>) => {
      audits.push(event);
      return Promise.resolve(undefined);
    },
  };
  const service = new EclService(
    repo as unknown as ConstructorParameters<typeof EclService>[0],
    audit as unknown as ConstructorParameters<typeof EclService>[1],
  );
  return { service, calls, audits };
}

/** The window as `eclPeriodRef` will store it — the idempotency key. */
function keyOf(c: CapturedRun): string {
  return eclPeriodRef(c.periodStart, c.periodEnd);
}

/**
 * Two instants on the SAME LOCAL DAY that straddle a UTC midnight, or
 * null when the host runs at UTC — where no such pair can exist, because
 * local midnight and UTC midnight are the same moment.
 *
 * Derived from the host's own offset rather than assuming Manila, so the
 * assertion means the same thing wherever the suite runs.
 */
function sameLocalDayStraddlingUtcMidnight(): [Date, Date] | null {
  // Local midnight on an arbitrary but fixed local day.
  const localMidnight = new Date(2026, 7, 15, 0, 0, 0, 0);
  const dayMs = 86_400_000;

  // The first UTC midnight strictly after local midnight.
  const utcMidnight = new Date(localMidnight);
  utcMidnight.setUTCHours(0, 0, 0, 0);
  if (utcMidnight.getTime() <= localMidnight.getTime()) {
    utcMidnight.setTime(utcMidnight.getTime() + dayMs);
  }
  // Does it fall inside this local day, with an hour of room either side?
  const offsetIntoDay = utcMidnight.getTime() - localMidnight.getTime();
  if (offsetIntoDay < 3_600_000 || offsetIntoDay > dayMs - 3_600_000) {
    return null;
  }
  return [
    new Date(utcMidnight.getTime() - 3_600_000),
    new Date(utcMidnight.getTime() + 3_600_000),
  ];
}

afterEach(() => {
  vi.useRealTimers();
});

// ─── The default window ─────────────────────────────────────────────────

describe("EclService.run — the default period window", () => {
  it("defaults periodEnd to UTC midnight on the LOCAL calendar date", async () => {
    const now = new Date("2026-08-15T09:41:37.482Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    /*
     * CHANGED. This used to be the request INSTANT, hours and all —
     * which is what let the key move at UTC midnight. It is now a
     * calendar date, and the date is the LOCAL one, so the whole of an
     * operator's working day maps to one window.
     */
    expect(calls[0]!.periodEnd.toISOString()).toBe(
      `${todayLocalISO(now)}T00:00:00.000Z`,
    );
    expect(calls[0]!.periodEnd.getUTCHours()).toBe(0);
    expect(calls[0]!.periodEnd.getUTCMinutes()).toBe(0);
    expect(calls[0]!.periodEnd.getUTCSeconds()).toBe(0);
    expect(calls[0]!.periodEnd.getUTCMilliseconds()).toBe(0);
  });

  it("defaults periodStart to the first of the LOCAL month, as UTC midnight", async () => {
    const now = new Date("2026-08-15T09:41:37.482Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    /*
     * CHANGED. This used to be LOCAL midnight — `new Date(y, m, 1)` —
     * which on a host east of UTC renders back out as the last day of
     * the PREVIOUS month. Built as UTC midnight it round-trips through
     * `eclPeriodRef` as the date it was built from, on any host.
     */
    expect(calls[0]!.periodStart.toISOString()).toBe(
      `${todayLocalISO(now).slice(0, 8)}01T00:00:00.000Z`,
    );
    expect(calls[0]!.periodStart.getUTCDate()).toBe(1);
  });

  it("passes asOf EXPLICITLY, holding the instant periodEnd used to carry", async () => {
    const now = new Date("2026-08-15T09:41:37.482Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    /*
     * CHANGED, and this is the assertion that shows no ECL figure moved.
     * The figures hang off `asOf`. It used to be omitted, so
     * `EclRepository.run` fell back to `asOf = periodEnd` = the request
     * instant. Now that `periodEnd` is a date, that fallback would have
     * silently re-measured every on-demand run as of local midnight —
     * moving DPD, staging and every ECL number. Passing the instant
     * explicitly keeps the as-of moment exactly where it was.
     */
    expect(calls[0]!.asOf).toBeInstanceOf(Date);
    expect(calls[0]!.asOf!.getTime()).toBe(now.getTime());
  });

  it("leaves asOf to the repository when the window is explicit", async () => {
    const { service, calls } = harness();
    await service.run({
      input: { periodEnd: "2026-06-30" },
      actorId: "user-1",
    });

    // A period asked for by name is measured at its end, not today —
    // the repository's own `asOf = periodEnd` fallback, unchanged.
    expect(calls[0]!.asOf).toBeUndefined();
  });

  it("carries the actor and notes through unchanged", async () => {
    const { service, calls, audits } = harness();
    await service.run({
      input: { notes: "month-end close" },
      actorId: "user-7",
    });

    expect(calls[0]!.computedById).toBe("user-7");
    expect(calls[0]!.notes).toBe("month-end close");
    expect(audits[0]).toEqual({
      action: "ECL_RUN",
      actorId: "user-7",
      targetType: "EclRun",
      targetId: "run-1",
      payload: {
        totalEcl: 780,
        stages: { STAGE_1: 1, STAGE_2: 1, STAGE_3: 1 },
      },
    });
  });
});

// ─── Explicit inputs ────────────────────────────────────────────────────

describe("EclService.run — explicitly supplied window", () => {
  it("takes a date-only periodEnd as UTC midnight, and keys on that date", async () => {
    const { service, calls } = harness();
    await service.run({
      input: { periodStart: "2026-06-01", periodEnd: "2026-06-30" },
      actorId: "user-1",
    });

    // `new Date("2026-06-30")` is UTC midnight — the key renders cleanly.
    expect(calls[0]!.periodStart.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(calls[0]!.periodEnd.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(keyOf(calls[0]!)).toBe("2026-06-01:2026-06-30");
  });

  it("derives periodStart from an explicit periodEnd's own month, in UTC", async () => {
    const { service, calls } = harness();
    await service.run({
      input: { periodEnd: "2026-06-30T12:00:00.000Z" },
      actorId: "user-1",
    });

    /*
     * CHANGED. This used to be `new Date(end.getFullYear(), ...)` —
     * local components on a UTC instant — so on a UTC+8 host a request
     * for the period ending 2026-06-30 stored a start of
     * `2026-05-31T16:00:00Z` and keyed itself "2026-05-31:2026-06-30".
     * The month is now read in UTC, matching how the end arrived.
     */
    expect(calls[0]!.periodStart.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(keyOf(calls[0]!)).toBe("2026-06-01:2026-06-30");
  });
});

// ─── The defect: an instant-derived key ─────────────────────────────────

describe("EclService.run — the period key is derived from an instant", () => {
  /**
   * THE DEFECT, now closed — and this is the assertion that flipped.
   *
   * It used to read "…derive DIFFERENT keys": two runs an hour apart on
   * one local working day keyed to two different periods, so the unique
   * index on (source, sourceRefType, sourceRefId) had nothing to catch
   * and the movement booked twice. In Manila that split every local day
   * at 08:00.
   *
   * The window is now the local calendar day, so both runs key the same
   * period and the second collides — `ALREADY_POSTED`, one entry.
   */
  it("gives same-local-day instants straddling UTC midnight the SAME key", async () => {
    const pair = sameLocalDayStraddlingUtcMidnight();
    if (!pair) {
      // Host runs at UTC; local and UTC midnight coincide, so the defect
      // is invisible here. It is not invisible in Manila.
      return;
    }
    const [before, after] = pair;

    // Same local calendar day…
    expect(before.getDate()).toBe(after.getDate());
    expect(before.getMonth()).toBe(after.getMonth());
    expect(before.getFullYear()).toBe(after.getFullYear());
    // …but different UTC calendar dates.
    expect(before.toISOString().slice(0, 10)).not.toBe(
      after.toISOString().slice(0, 10),
    );

    const { service, calls } = harness();

    vi.useFakeTimers();
    vi.setSystemTime(before);
    await service.run({ input: {}, actorId: "user-1" });

    vi.setSystemTime(after);
    await service.run({ input: {}, actorId: "user-1" });

    // One key for one business day — the second run now collides.
    expect(keyOf(calls[0]!)).toBe(keyOf(calls[1]!));
    // And it is the local date, not the UTC date of either instant.
    expect(keyOf(calls[0]!).endsWith(todayLocalISO(before))).toBe(true);

    /*
     * The as-of moments still differ, and must: each run measured the
     * book at the moment it ran. Only the WINDOW is shared.
     */
    expect(calls[0]!.asOf!.getTime()).toBe(before.getTime());
    expect(calls[1]!.asOf!.getTime()).toBe(after.getTime());
  });

  it("keys two instants on the same local date identically", async () => {
    const { service, calls } = harness();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T01:00:00.000Z"));
    await service.run({ input: {}, actorId: "user-1" });

    vi.setSystemTime(new Date("2026-08-15T15:59:00.000Z"));
    await service.run({ input: {}, actorId: "user-1" });

    expect(keyOf(calls[0]!)).toBe(keyOf(calls[1]!));
  });

  it("ends the key on the LOCAL date of the instant, not the UTC date", async () => {
    const now = new Date("2026-08-14T23:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    /*
     * CHANGED. 23:30Z on the 14th is 07:30 on the 15th in Manila. The
     * key used to say the 14th, so an operator's early-morning run was
     * filed under yesterday and their 09:00 run under today — two
     * windows, two postings. It now says whatever local date the
     * operator is actually standing in.
     */
    expect(keyOf(calls[0]!).endsWith(todayLocalISO(now))).toBe(true);
    expect(keyOf(calls[0]!)).toBe(
      `${todayLocalISO(now).slice(0, 8)}01:${todayLocalISO(now)}`,
    );
  });
});
