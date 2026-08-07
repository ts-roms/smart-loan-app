import { z } from "zod";

/**
 * Audit-log read filter. Every field is optional — the UI typically
 * fills one or two (e.g. "everything done by user X in the last week")
 * and leaves the rest blank.
 */
export const listQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  /**
   * Free text over the actor's name and email. Separate from `actorId`,
   * which pins an exact person: an investigator usually knows the name
   * they are looking for, not the uuid behind it.
   */
  actor: z.string().trim().min(1).max(120).optional(),
  action: z.string().min(1).max(120).optional(),
  targetType: z.string().min(1).max(60).optional(),
  targetId: z.string().min(1).max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  /**
   * Retained for callers that just want "the newest N" — the actions
   * dropdown and any script hitting this endpoint directly. Ignored
   * when `page` is present, because a caller asking for a page has
   * already said how many rows it wants.
   */
  take: z.coerce.number().int().positive().max(500).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});
export type AuditListQuery = z.infer<typeof listQuerySchema>;
