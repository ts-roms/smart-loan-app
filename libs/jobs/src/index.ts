/**
 * @loan/jobs — lightweight in-process job scheduler.
 *
 * Each named job is a pure async function `(ctx) => result`. The runtime
 * (`createScheduler`) consults `ScheduledJob` rows for the cron expression
 * and enabled flag, persists each execution into `JobRun`, and ticks via
 * `setInterval`.
 *
 * Why not BullMQ? It's a real queue with Redis. We don't need Redis-level
 * fan-out yet, and a 30-line scheduler over the existing Postgres covers
 * 95% of the use case. The job-function signature is identical to what
 * BullMQ workers expect, so swapping is a runtime change, not a code change.
 */

import parser from "cron-parser";

export interface JobContext {
  /** Run id (matches the JobRun row). */
  runId: string;
  /** UTC start time. */
  startedAt: Date;
  /** True if triggered manually (from /jobs/:name/run). */
  manual: boolean;
}

export type JobFn = (ctx: JobContext) => Promise<unknown>;

export interface JobDefinition {
  name: string;
  description: string;
  /** Default cron used at first registration; admin can edit per-row. */
  defaultCron: string;
  fn: JobFn;
}

export function parseNextRun(cron: string, from: Date = new Date()): Date {
  return parser.parseExpression(cron, { currentDate: from }).next().toDate();
}

export function cronIsValid(cron: string): boolean {
  try {
    parser.parseExpression(cron);
    return true;
  } catch {
    return false;
  }
}
