import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { JobRepository } from "./job.repository";

/**
 * Invariant: a due job runs exactly once per scheduled slot.
 *
 * Two ways that was violated before the slot claim:
 *
 *   1. Self-overlap, needing no concurrency at all. `nextRunAt` advanced
 *      only after the job finished, and `setInterval` does not wait for
 *      an async tick — so any job slower than the tick interval was still
 *      "due" when the next tick looked, and started again on top of
 *      itself. For interest accrual that means posting the same accrual
 *      twice.
 *
 *   2. Two API processes both seeing the job as due and both running it.
 *
 * The fix advances `nextRunAt` BEFORE running, with the old value in the
 * WHERE clause — a compare-and-swap only one caller can win.
 */

const CRON = "0 * * * *"; // hourly, so parseNextRun always moves forward

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    name: "accrue-interest",
    cron: CRON,
    enabled: true,
    nextRunAt: new Date("2020-01-01T00:00:00.000Z"), // long overdue
    ...overrides,
  };
}

/**
 * Prisma stand-in whose `updateMany` models a compare-and-swap: it only
 * "matches" while the stored nextRunAt still equals what the caller read.
 */
function fakePrisma(job: ReturnType<typeof jobRow>) {
  const state = { nextRunAt: job.nextRunAt };
  const ran: string[] = [];
  const client = {
    scheduledJob: {
      // Honours the due filter, as Postgres would: once the slot has
      // been claimed the row is no longer overdue and is not returned.
      findMany: ({ where }: { where: { nextRunAt: { lte: Date } } }) =>
        Promise.resolve(
          state.nextRunAt.getTime() <= where.nextRunAt.lte.getTime()
            ? [{ ...job, nextRunAt: state.nextRunAt }]
            : [],
        ),
      findFirst: () => Promise.resolve({ ...job, nextRunAt: state.nextRunAt }),
      // runOne looks the job back up by name before executing it.
      findUnique: () => Promise.resolve({ ...job, nextRunAt: state.nextRunAt }),
      updateMany: ({
        where,
        data,
      }: {
        where: { nextRunAt: Date };
        data: { nextRunAt: Date };
      }) => {
        if (state.nextRunAt.getTime() !== where.nextRunAt.getTime()) {
          return Promise.resolve({ count: 0 });
        }
        state.nextRunAt = data.nextRunAt;
        return Promise.resolve({ count: 1 });
      },
      update: () => Promise.resolve(job),
    },
    jobRun: {
      create: () =>
        Promise.resolve({
          id: "run-1",
          startedAt: new Date(),
          manual: false,
        }),
      update: () => Promise.resolve({ id: "run-1" }),
    },
    __ran: ran,
    __state: state,
  };
  return client as unknown as PrismaClient & {
    __ran: string[];
    __state: typeof state;
  };
}

describe("tickDueJobs — one run per slot", () => {
  it("runs a due job once and advances the slot before running it", async () => {
    const prisma = fakePrisma(jobRow());
    const repo = new JobRepository(prisma);
    const order: string[] = [];

    await repo.tickDueJobs([
      {
        name: "accrue-interest",
        description: "",
        defaultCron: CRON,
        fn: async () => {
          // By the time the job body runs, the slot must already be
          // claimed — otherwise a concurrent tick could still take it.
          order.push("ran");
          expect(prisma.__state.nextRunAt.getTime()).toBeGreaterThan(
            new Date("2020-01-01T00:00:00.000Z").getTime(),
          );
          return null;
        },
      },
    ]);

    expect(order).toEqual(["ran"]);
  });

  it("a later tick sees the slot is no longer due", async () => {
    const prisma = fakePrisma(jobRow());
    const repo = new JobRepository(prisma);
    let runs = 0;
    const def = {
      name: "accrue-interest",
      description: "",
      defaultCron: CRON,
      fn: async () => {
        runs += 1;
        return null;
      },
    };

    await repo.tickDueJobs([def]);
    await repo.tickDueJobs([def]);

    expect(runs).toBe(1);
  });

  it("two overlapping ticks run the job once between them", async () => {
    /*
     * The real race, and the one that needs no second process: tick two
     * fires while tick one is still in flight, so BOTH read the same
     * stale nextRunAt before either claims it. Only one swap can land.
     *
     * Before the claim this ran the job twice — for interest accrual,
     * the same accrual posted twice.
     */
    const prisma = fakePrisma(jobRow());
    const repo = new JobRepository(prisma);
    let runs = 0;
    const def = {
      name: "accrue-interest",
      description: "",
      defaultCron: CRON,
      fn: async () => {
        runs += 1;
        // Hold the slot open long enough for the other tick to be well
        // past its own read.
        await new Promise((r) => setTimeout(r, 20));
        return null;
      },
    };

    await Promise.all([repo.tickDueJobs([def]), repo.tickDueJobs([def])]);

    expect(runs).toBe(1);
  });

  it("skips jobs with no matching definition without claiming them", async () => {
    const prisma = fakePrisma(jobRow({ name: "unknown-job" }));
    const repo = new JobRepository(prisma);
    const before = prisma.__state.nextRunAt.getTime();

    await repo.tickDueJobs([]);

    // Nothing claimed: an unregistered job must stay due, so that a
    // deploy which adds the definition picks it up rather than having
    // silently burned the slot.
    expect(prisma.__state.nextRunAt.getTime()).toBe(before);
  });
});
