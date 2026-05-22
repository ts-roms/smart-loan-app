import { z } from "zod";

/**
 * Audit-log read filter. Every field is optional — the UI typically
 * fills one or two (e.g. "everything done by user X in the last week")
 * and leaves the rest blank.
 */
export const listQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().min(1).max(120).optional(),
  targetType: z.string().min(1).max(60).optional(),
  targetId: z.string().min(1).max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  take: z.coerce.number().int().positive().max(500).optional(),
});
export type AuditListQuery = z.infer<typeof listQuerySchema>;
