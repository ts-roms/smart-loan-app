/**
 * Compliance route schemas. Used by the controller for input
 * validation; the service signatures mirror the inferred types.
 */

import { z } from "zod";

/**
 * Body for POST /compliance/customers/:id/export. The reason is
 * optional for export (vs erasure where it's mandatory) — the
 * default audit row already captures who + when, but a free-form
 * note ties the export to a ticket number or DSAR ID.
 */
export const exportRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});

/**
 * Body for POST /compliance/customers/:id/erase. Mandatory reason +
 * mandatory acknowledgment that financial records are retained.
 * The service refuses to run without both — they're the dual
 * safeguard that erasure isn't fired accidentally.
 */
export const eraseRequestSchema = z.object({
  /** Free-form audit note. Auditors always want a reason. */
  reason: z.string().min(8).max(500),
  /** Must be `true`. The UI puts a checkbox next to a notice
   * explaining what stays (financial records) vs what goes (PII).
   * Without an explicit `true`, the service kicks back a 400. */
  acknowledgesRetention: z.literal(true),
});

/** `:id` — the customer a DSAR is being answered for. */
export const customerIdParamSchema = z.object({ id: z.string().uuid() });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts). No money anywhere in this feature — the export blob
 * carries loan and payment rows, but as opaque objects (see below), so
 * the Decimal rule never has to be applied field by field here.
 */

/**
 * POST /compliance/customers/:id/export — the subject-access blob.
 *
 * Deliberately flat-by-table rather than nested, so a data subject (or
 * the cooperative they are moving to) can consume one section at a
 * time. Sent with `Content-Disposition: attachment` — it is JSON, but
 * it is meant to land as a file.
 *
 * Every section is `z.record(z.unknown())` rather than the real row
 * shape, and that is the honest declaration rather than a lazy one.
 * The contract this endpoint offers is "every table that holds data
 * about this customer, whole" — not "these columns". Pinning the
 * columns here would mean that adding a field to Customer, or a new
 * table to the export, silently DROPPED it from the DSAR response,
 * because Fastify serialises against this schema. For a
 * right-to-portability endpoint that failure is a compliance breach,
 * not a documentation nit: the regulator's question is whether the
 * subject received everything.
 *
 * So the array-ness and the section names are the contract, and each
 * row is passed through untouched.
 */
export const exportResponseSchema = z.object({
  ok: z.literal(true),
  /** ISO-8601. Also embedded in the download filename. */
  generatedAt: z.string(),
  /** The Customer row itself, whole. */
  customer: z.record(z.unknown()),
  kycSubmissions: z.array(z.record(z.unknown())),
  loanApplications: z.array(z.record(z.unknown())),
  schedules: z.array(z.record(z.unknown())),
  payments: z.array(z.record(z.unknown())),
  auditEvents: z.array(z.record(z.unknown())),
  contributions: z.array(z.record(z.unknown())),
  savingsTransactions: z.array(z.record(z.unknown())),
  amlScreenings: z.array(z.record(z.unknown())),
  surveyResponses: z.array(z.record(z.unknown())),
  creditScores: z.array(z.record(z.unknown())),
  notifications: z.array(z.record(z.unknown())),
});

/**
 * POST /compliance/customers/:id/erase — what was redacted and what
 * deliberately was not.
 *
 * `retainedTables` is the important half and the reason this answers a
 * body rather than a 204. Erasure here is a soft one: PII columns on
 * the Customer row are overwritten in place, while the regulated
 * financial records stay (AMLA §9 / BSP 706 mandate 5 years, and the
 * foreign keys would not survive a hard delete anyway). The response
 * names both sets so the operator can tell the data subject precisely
 * what happened.
 */
export const eraseResponseSchema = z.object({
  ok: z.literal(true),
  customerId: z.string().uuid(),
  /** ISO-8601. */
  erasedAt: z.string(),
  /** Customer columns overwritten with the [ERASED] placeholder. */
  fieldsCleared: z.array(z.string()),
  /** Tables left intact, and therefore still holding regulated data. */
  retainedTables: z.array(z.string()),
});
