/**
 * Retention-policy wire schemas.
 *
 * The numeric bounds here stay generous on purpose: they answer "is
 * this a number of days at all", not "is this a lawful policy". The
 * AMLA floor is enforced a layer in, by `RetentionService.updatePolicy`,
 * which answers a 422 with the floor and the requested value. Encoding
 * the floor as a zod `.min()` would collapse a policy refusal into a
 * schema validation error and lose that explanation — and it cannot
 * express the rule anyway, since 0 ("never purge") is legal while 365
 * is not.
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
  /**
   * OPTIONAL where the other three are required. Not an oversight: this knob
   * was added after the endpoint shipped, and making it mandatory would 400
   * every body written against the old contract. Omitted means "leave the
   * stored value alone" — see `RetentionService.updatePolicy`.
   */
  loginAttemptRetentionDays: z
    .number()
    .int()
    .min(RETENTION_MIN)
    .max(RETENTION_MAX)
    .optional(),
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
 * read. It is false when the window is 0, because 0 means "never
 * purge", which is above the floor rather than below it.
 *
 * PUT now REFUSES a below-floor window (422), so this flag can only be
 * true for a row written before that refusal existed. It stays in the
 * shape for exactly that case: a tenant carrying a legacy 365-day
 * setting still needs the UI to show why, and GET is the only thing
 * that will tell them.
 */
export const retentionPolicyResponseSchema = z.object({
  auditRetentionDays: z.number().int(),
  notificationRetentionDays: z.number().int(),
  jobRunRetentionDays: z.number().int(),
  /**
   * The security log's own window. Separate from the audit one because the
   * audit window is anchored to the AMLA §9 floor and this is high-volume
   * personal data with no such floor under it.
   */
  loginAttemptRetentionDays: z.number().int(),
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
    loginAttemptRetentionDays: z.number().int(),
  }),
  /** Per-table cutoff instants. Null = opted out, nothing attempted. */
  cutoffs: z.object({
    audit: z.string().nullable(),
    notification: z.string().nullable(),
    jobRun: z.string().nullable(),
    loginAttempt: z.string().nullable(),
  }),
  deleted: z.object({
    auditEvents: z.number().int(),
    notifications: z.number().int(),
    jobRuns: z.number().int(),
    loginAttempts: z.number().int(),
  }),
  /**
   * Rows the run REDACTED rather than deleted — protected audit records past
   * the audit cutoff whose `ipAddress`/`userAgent` were nulled in place.
   *
   * Contractual, and deliberately NOT folded into `deleted`. The two numbers
   * answer to different obligations: a count here is evidence that §71
   * minimisation ran over the rows §56 will not let go, and a count in
   * `deleted.auditEvents` is evidence that a record went away. Summing them
   * would make an operator unable to tell which happened.
   */
  redacted: z.object({
    auditEvents: z.number().int(),
  }),
  /**
   * The closed list of audit actions this run was allowed to delete.
   *
   * Contractual because it is the answer to the question the numbers
   * provoke. `deleted.auditEvents: 3` against a five-year-old table
   * looks broken until you can see that the sweep was only ever
   * permitted to touch report-generation and assistant rows; every
   * financial, security and unclassified action is out of the clock's
   * reach at any retention setting. See audit-retention.ts.
   */
  auditActionsInScope: z.array(z.string()),
});
