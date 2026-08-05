import { z } from "zod";

/**
 * Collections request shapes. Notes capture interactions with the
 * borrower (call/SMS/email/visit); promises-to-pay (PTPs) are
 * lightweight forecasts the borrower commits to. Resolution updates
 * the PTP's terminal state.
 */

export const noteSchema = z.object({
  type: z.enum(["CALL", "SMS", "EMAIL", "VISIT", "OTHER"]).default("OTHER"),
  body: z.string().min(1).max(2000),
});
export type NoteInput = z.infer<typeof noteSchema>;

export const ptpSchema = z.object({
  amount: z.number().positive(),
  promisedDate: z.string(),
  note: z.string().max(500).optional(),
});
export type PtpInput = z.infer<typeof ptpSchema>;

export const resolveSchema = z.object({
  status: z.enum(["HONORED", "BROKEN", "CANCELLED"]),
});
export type ResolveInput = z.infer<typeof resolveSchema>;

/**
 * Hand an account to a collector, or move it to a different one.
 *
 * `collector` takes a user UUID or an email address. Requiring the UUID
 * meant every caller had to look one up first, and made a bulk
 * reassignment script — or the audit payload it produces — unreadable.
 * The UI picker keeps sending ids; a human writing curl can send
 * "ana@coop.local".
 *
 * Kept as one field rather than collectorId/collectorEmail: two
 * optional fields need a refinement to reject both-or-neither, and
 * callers then have to decide which to populate for an identifier they
 * are just passing through.
 */
export const assignSchema = z.object({
  collector: z.union([z.string().uuid(), z.string().email()]),
  note: z.string().max(500).optional(),
});
export type AssignInput = z.infer<typeof assignSchema>;

/**
 * Bulk assignment — one collector, many accounts. Capped at 500 like
 * the other batch endpoints; the queue itself is far smaller in any
 * sane book, and a runaway client shouldn't be able to queue thousands
 * of upserts in one transaction.
 */
export const bulkAssignSchema = z.object({
  loanIds: z.array(z.string().uuid()).min(1).max(500),
  collector: z.union([z.string().uuid(), z.string().email()]),
  note: z.string().max(500).optional(),
});
export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;

/**
 * Queue scope.
 *
 *   all         every delinquent account (the existing shared worklist)
 *   mine        only the caller's own — the collector dashboard
 *   unassigned  the pool a supervisor hands out from
 *
 * `mine` resolves to the caller's own id server-side and never accepts
 * a collectorId from the client: letting the caller name whose queue to
 * read would turn a collector's own-accounts view into a way to read
 * everyone else's book.
 */
export const queueScopeSchema = z.object({
  scope: z.enum(["all", "mine", "unassigned"]).default("all"),
});
export type QueueScope = z.infer<typeof queueScopeSchema>;
