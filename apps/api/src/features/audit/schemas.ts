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

/**
 * One audit row, as the service hands it out.
 *
 * A flattened projection, not the stored row: the query joins the actor
 * and the service lifts `name`/`email` up to the top level, so there is
 * no nested `actor` object on the wire. `impersonatedById` and
 * `impersonatedByEmail` are on the model and deliberately NOT mapped
 * out — they are not part of this response today.
 *
 * `payload` is the event's own JSON and differs per `action`, so it is
 * `z.unknown()`: there is no one shape to describe, and claiming one
 * would strip the fields of every action that disagreed with it.
 */
export const auditEventResponseSchema = z.object({
  id: z.string().uuid(),
  /** e.g. "LOAN_APPROVED", "JOURNAL_REVERSE_BULK". */
  action: z.string(),
  actorId: z.string().uuid(),
  /** Null only defensively — the join can miss a deleted user. */
  actorName: z.string().nullable(),
  actorEmail: z.string().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  /** Action-specific detail. Shape varies with `action`. */
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});

/** `GET /audit` — the offset-paginated envelope the list endpoints share. */
export const auditListResponseSchema = z.object({
  rows: z.array(auditEventResponseSchema),
  /** Total matching the filter across all pages — not rows.length. */
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** At least 1 even when nothing matched. */
  totalPages: z.number().int(),
});

/**
 * `GET /audit/distinct/actions` — every action name in use, sorted.
 *
 * A bare array of strings, which is what the filter dropdown needs. It
 * is read straight off the table rather than from a constant, so a new
 * action appears here the first time it is recorded.
 */
export const auditActionsResponseSchema = z.array(z.string());
