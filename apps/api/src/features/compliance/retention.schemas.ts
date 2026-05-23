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
