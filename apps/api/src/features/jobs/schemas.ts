import { z } from "zod";

/**
 * Jobs admin schemas — the request bodies the routes already validated,
 * now sitting beside the response shapes they answer with.
 *
 * Request shapes moved here out of `jobs.routes.ts` so both halves of
 * each endpoint's contract live in one file, the same way every other
 * feature keeps them.
 */

/**
 * The cron string only. Syntax is checked separately by `cronIsValid`
 * rather than by a regex here: a five-field cron with ranges, steps and
 * lists is not something a regex gets right, and a nearly-right one
 * would reject valid schedules — a job that silently cannot be
 * rescheduled is worse than a late error message.
 */
export const cronSchema = z.object({ cron: z.string().min(1).max(120) });

export const enabledSchema = z.object({ enabled: z.boolean() });

/** `:name` is the job's stable name ("accrue-interest-monthly"), not an id. */
export const jobNameParamSchema = z.object({ name: z.string().min(1) });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod rather than hand-written JSON Schema so they are real parsers and
 * a test can assert an actual payload against one. They describe what is
 * CONTRACTUAL, not everything a row carries — see lib/openapi.ts on why
 * undeclared fields pass through untouched.
 */

export const scheduledJobResponseSchema = z.object({
  id: z.string().uuid(),
  /** Stable name; every other route in this feature keys on it. */
  name: z.string(),
  description: z.string().nullable(),
  /** Standard five-field cron, e.g. "0 1 * * *". */
  cron: z.string(),
  /** A disabled job is skipped by the scheduler; manual runs still work. */
  enabled: z.boolean(),
  lastRunAt: z.string().datetime().nullable(),
  /** Advanced by the scheduler as it claims each slot. */
  nextRunAt: z.string().datetime().nullable(),
});

export const scheduledJobListResponseSchema = z.array(
  scheduledJobResponseSchema,
);

/**
 * One recorded run.
 *
 * `result` is deliberately NOT declared. It is free-form per job — the
 * accrual job returns `{ posted, skipped }`, another returns something
 * else entirely — and a schema claiming a shape for it would be wrong
 * for most jobs. Undeclared, it passes through exactly as stored.
 */
export const jobRunResponseSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
  startedAt: z.string().datetime(),
  /** Null while the run is still in flight. */
  finishedAt: z.string().datetime().nullable(),
  /** The failure message on a FAILED run; null otherwise. */
  error: z.string().nullable(),
  /** False means the scheduler fired it, not an operator. */
  manual: z.boolean(),
});

export const jobRunListResponseSchema = z.array(jobRunResponseSchema);
