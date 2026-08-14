/**
 * Retention-policy wire schemas. Bounds are intentionally generous —
 * the platform doesn't enforce a regulatory floor (the UI surfaces a
 * warning instead, and the audit log captures whoever lowered it).
 */

import { z } from "zod";

/** Max ~30 years; the floor is 0 ("never purge"). */
const RETENTION_MIN = 0;
const RETENTION_MAX = 365 * 30;

export const retentionPolicyUpdateSchema = z.object({
  auditRetentionDays: z.number().int().min(RETENTION_MIN).max(RETENTION_MAX),
  notificationRetentionDays: z
    .number()
    .int()
    .min(RETENTION_MIN)
    .max(RETENTION_MAX),
  jobRunRetentionDays: z.number().int().min(RETENTION_MIN).max(RETENTION_MAX),
});

export type RetentionPolicyUpdateInput = z.infer<
  typeof retentionPolicyUpdateSchema
>;

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts).
 */

/**
 * The retention policy as read or after a write — GET and PUT answer
 * the identical shape.
 *
 * `auditBelowAmlaFloor` is DERIVED, not stored: the service compares
 * the configured window against the 1,825-day AMLA §9 floor on every
 * read. The platform deliberately does not enforce that floor — going
 * below it is a compliance officer's call — so this flag is how the UI
 * gets to warn without the API refusing. Note it is false when the
 * window is 0, because 0 means "never purge", which is above the floor
 * rather than below it.
 */
export const retentionPolicyResponseSchema = z.object({
  auditRetentionDays: z.number().int(),
  notificationRetentionDays: z.number().int(),
  jobRunRetentionDays: z.number().int(),
  /** True only when the audit window is set, and set below 1,825 days. */
  auditBelowAmlaFloor: z.boolean(),
});

/**
 * POST /compliance/retention-purge — what the manual run actually did.
 *
 * A `null` cutoff and a zero count are different facts, and the shape
 * keeps them apart on purpose: null means the table is opted out
 * (days = 0, never purge) so nothing was attempted, while a non-null
 * cutoff with `deleted: 0` means the sweep ran and found nothing past
 * it. An operator who has just slashed a retention window needs to be
 * able to tell "it did nothing" from "it wasn't asked to".
 */
export const retentionPurgeResponseSchema = z.object({
  /** ISO-8601. */
  startedAt: z.string(),
  /** ISO-8601. */
  finishedAt: z.string(),
  /** The policy the run read, echoed so the numbers are self-explaining. */
  policy: z.object({
    auditRetentionDays: z.number().int(),
    notificationRetentionDays: z.number().int(),
    jobRunRetentionDays: z.number().int(),
  }),
  /** Per-table cutoff instants. Null = opted out, nothing attempted. */
  cutoffs: z.object({
    audit: z.string().nullable(),
    notification: z.string().nullable(),
    jobRun: z.string().nullable(),
  }),
  deleted: z.object({
    auditEvents: z.number().int(),
    notifications: z.number().int(),
    jobRuns: z.number().int(),
  }),
});
