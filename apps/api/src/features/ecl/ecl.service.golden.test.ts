import { eclPeriodRef } from "@loan/accounting";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EclService } from "./ecl.service";

/**
 * GOLDEN TESTS — ECL period defaulting (`EclService.run`).
 *
 * Written against the implementation as it stands and committed passing
 * BEFORE any change, per §81. These pin what the CURRENT defaulting
 * produces, including the two things about it that are wrong.
 *
 * ── What the current implementation does, exactly ──────────────────────
 *
 * With neither `periodStart` nor `periodEnd` supplied (the only way the
 * UI ever calls it — `POST /ecl/runs` has no body schema and the page
 * sends `{}`):
 *
 *   periodEnd   = `new Date()` — the INSTANT the request landed,
 *                 hours/minutes/seconds and all.
 *   periodStart = `new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1)`
 *                 — LOCAL midnight on the first of the LOCAL month.
 *   asOf        = not passed at all, so `EclRepository.run` defaults it
 *                 to `periodEnd`, i.e. the same instant.
 *
 * `asOf` is what feeds DPD → staging → the ECL figures. `periodStart`
 * and `periodEnd` additionally feed `eclPeriodRef`, which is the journal
 * entry's idempotency key and is stringified with
 * `toISOString().slice(0, 10)` — a **UTC** calendar date.
 *
 * ── Defect 1: the key is derived from an instant, not a date ───────────
 *
 * Because `periodEnd` is an instant and the key takes its UTC date, two
 * runs on the same LOCAL day land on different keys as soon as they fall
 * either side of UTC midnight. `postIfAbsent` then has nothing to
 * collide with and the movement is booked a second time — the exact
 * double-post that keying on the period was meant to close.
 *
 * In Manila (UTC+8) UTC midnight is 08:00 local, so every local day is
 * split in two: a run at 07:00 keys to yesterday's date, a run at 09:00
 * keys to today's. That is most of a working day, not an edge case.
 *
 * `same-local-day instants straddling UTC midnight derive DIFFERENT
 * keys` below pins this. It is the assertion that pins the defect, and
 * it is the one expected to flip.
 *
 * ── Defect 2: the default periodStart renders as the WRONG MONTH ───────
 *
 * `new Date(y, m, 1)` is local midnight. Rendered back out as a UTC
 * date by `eclPeriodRef`, a host east of UTC gives the last day of the
 * PREVIOUS month: in Manila `new Date(2026, 7, 1)` is
 * `2026-07-31T16:00:00Z`, so the stored key and the entry memo both say
 * "2026-07-31" for a run the operator asked for on 1 August. The key is
 * immutable stored data, and it is not even stable across deployments —
 * the same request keys differently on a UTC host and a Manila one.
 *
 * These tests state that in a host-timezone-independent way: they pin
 * the local-midnight CONSTRUCTION (`getTime()` against locally-built
 * dates) rather than a rendered string that would only be wrong in some
 * timezones.
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
  it("defaults periodEnd to the INSTANT of the request, not a date", async () => {
    const now = new Date("2026-08-15T09:41:37.482Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    // Not truncated to a day in any timezone — the full instant.
    expect(calls[0]!.periodEnd.getTime()).toBe(now.getTime());
    expect(calls[0]!.periodEnd.getUTCHours()).toBe(9);
    expect(calls[0]!.periodEnd.getUTCMinutes()).toBe(41);
    expect(calls[0]!.periodEnd.getUTCSeconds()).toBe(37);
    expect(calls[0]!.periodEnd.getUTCMilliseconds()).toBe(482);
  });

  it("defaults periodStart to LOCAL midnight on the first of the LOCAL month", async () => {
    const now = new Date("2026-08-15T09:41:37.482Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    const expected = new Date(now.getFullYear(), now.getMonth(), 1);
    expect(calls[0]!.periodStart.getTime()).toBe(expected.getTime());
    // Local midnight — stated as local components so this holds anywhere.
    expect(calls[0]!.periodStart.getHours()).toBe(0);
    expect(calls[0]!.periodStart.getMinutes()).toBe(0);
    expect(calls[0]!.periodStart.getSeconds()).toBe(0);
    expect(calls[0]!.periodStart.getMilliseconds()).toBe(0);
    expect(calls[0]!.periodStart.getDate()).toBe(1);
  });

  it("passes NO asOf, so the repository derives it from periodEnd", async () => {
    const now = new Date("2026-08-15T09:41:37.482Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    /*
     * The figures hang off `asOf`. Today the service never sets it, and
     * `EclRepository.run` falls back to `asOf = periodEnd` — so the
     * as-of moment is the request instant. Any change that moves this
     * moves DPD, staging and every ECL number with it.
     */
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

  it("derives periodStart from an explicit periodEnd's LOCAL month", async () => {
    const { service, calls } = harness();
    await service.run({
      input: { periodEnd: "2026-06-30T12:00:00.000Z" },
      actorId: "user-1",
    });

    const end = new Date("2026-06-30T12:00:00.000Z");
    expect(calls[0]!.periodStart.getTime()).toBe(
      new Date(end.getFullYear(), end.getMonth(), 1).getTime(),
    );
  });
});

// ─── The defect: an instant-derived key ─────────────────────────────────

describe("EclService.run — the period key is derived from an instant", () => {
  /**
   * THE DEFECT. Two runs an hour apart, on one local working day, key
   * to two different periods — so the unique index on
   * (source, sourceRefType, sourceRefId) has nothing to catch and the
   * movement is booked twice.
   *
   * This assertion is expected to FLIP. It pins a defect, not a
   * requirement: what the system owes its operator is that re-running on
   * the same business day is idempotent.
   */
  it("gives same-local-day instants straddling UTC midnight DIFFERENT keys", async () => {
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

    // Two keys for one business day — nothing for postIfAbsent to catch.
    expect(keyOf(calls[0]!)).not.toBe(keyOf(calls[1]!));
  });

  it("keys two instants on the same UTC date identically", async () => {
    const { service, calls } = harness();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T01:00:00.000Z"));
    await service.run({ input: {}, actorId: "user-1" });

    vi.setSystemTime(new Date("2026-08-15T15:59:00.000Z"));
    await service.run({ input: {}, actorId: "user-1" });

    // The guard works — but only for instants that share a UTC date.
    expect(keyOf(calls[0]!)).toBe(keyOf(calls[1]!));
    expect(keyOf(calls[0]!).endsWith("2026-08-15")).toBe(true);
  });

  it("ends the key on the UTC date of the instant, whatever the local date", async () => {
    const now = new Date("2026-08-14T23:30:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { service, calls } = harness();
    await service.run({ input: {}, actorId: "user-1" });

    /*
     * 23:30Z on the 14th is 07:30 on the 15th in Manila. The key says
     * the 14th: the operator's Saturday morning run is filed under
     * Friday, and their 09:00 run will be filed under Saturday.
     */
    expect(keyOf(calls[0]!).endsWith("2026-08-14")).toBe(true);
  });
});
