import { z } from "zod";

/**
 * Create a renewable document record on a loan. Effective + expiry are
 * ISO strings; the repo coerces them to Date so the wire format stays
 * JSON-friendly while storage stays typed.
 */
export const createSchema = z.object({
  type: z.enum(["CAR_INSURANCE", "OR_CR", "RPT", "FIRE_INSURANCE", "OTHER"]),
  name: z.string().min(1).max(200),
  documentUrl: z.string().max(500).optional(),
  effectiveFrom: z.string(),
  expiresAt: z.string(),
  notes: z.string().max(500).optional(),
});

export type CreateAnnualDocInput = z.infer<typeof createSchema>;

/** Query for /annual-docs/expiring — defaults to 30 days when absent. */
export const listExpiringQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export type ListExpiringQuery = z.infer<typeof listExpiringQuerySchema>;

/** `:loanId` on the per-loan routes. */
export const loanIdParamSchema = z.object({ loanId: z.string().uuid() });

/** `:id` on the cross-loan delete — an AnnualDocument, not a loan. */
export const docIdParamSchema = z.object({ id: z.string().uuid() });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts). Nothing in this feature is money — it tracks
 * expiry dates, not amounts — so the Decimal rule never applies.
 */

const docTypeSchema = z.enum([
  "CAR_INSURANCE",
  "OR_CR",
  "RPT",
  "FIRE_INSURANCE",
  "OTHER",
]);

/**
 * Where a document stands against its expiry date.
 *
 * Persisted rather than derived per query, which is why the nightly
 * refresh job (and its manual trigger) exists: the dashboard filters on
 * this column cheaply instead of recomputing from `expiresAt` on every
 * read. It follows that a row's `status` can lag reality by up to a day
 * — `EXPIRING_SOON` means "was within 30 days at the last refresh".
 */
const docStatusSchema = z.enum(["VALID", "EXPIRING_SOON", "EXPIRED"]);

/** One renewable document on a loan, as stored. */
export const annualDocResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  type: docTypeSchema,
  /** Display label, e.g. "Comprehensive insurance 2026-2027". */
  name: z.string(),
  documentUrl: z.string().nullable(),
  effectiveFrom: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: docStatusSchema,
  notes: z.string().nullable(),
  submittedAt: z.string().datetime(),
  submittedById: z.string(),
  /** Last reminder sent, so the daily job does not re-spam the borrower. */
  lastReminderAt: z.string().datetime().nullable(),
  reminderCount: z.number().int(),
});

/** GET /loans/:loanId/annual-docs — soonest expiry first. */
export const annualDocListResponseSchema = z.array(annualDocResponseSchema);

/**
 * GET /annual-docs/expiring — soonest expiry first, each with its loan
 * reference.
 *
 * "Expiring" includes ALREADY EXPIRED rows: the query is
 * `expiresAt <= now + days`, with no lower bound. That is deliberate —
 * the page is a work queue, and a document that lapsed last week is
 * more urgent than one lapsing next week, not less.
 */
export const expiringListResponseSchema = z.array(
  annualDocResponseSchema.extend({
    loan: z.object({
      /** "LN-2026-000123". */
      number: z.string(),
      customerId: z.string().uuid(),
    }),
  }),
);

/**
 * POST /annual-docs/jobs/refresh-statuses — how the corpus looks after
 * the sweep. Counts EVERY row by its recomputed status, not just the
 * ones whose status changed, so the three figures total the table.
 */
export const refreshStatusesResponseSchema = z.object({
  valid: z.number().int(),
  expiringSoon: z.number().int(),
  expired: z.number().int(),
});
