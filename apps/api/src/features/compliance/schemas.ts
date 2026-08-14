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

/**
 * Body for POST /compliance/customers/:id/documents-purge.
 *
 * `dryRun` DEFAULTS TO TRUE. A caller who omits it gets the preview,
 * not the deletion — the §46 order is Dry Run before Migration, and the
 * safe default is the one that makes forgetting the flag harmless.
 * Deleting requires saying `false` on purpose.
 */
export const documentPurgeRequestSchema = z.object({
  reason: z.string().min(8).max(500),
  dryRun: z.boolean().default(true),
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
 * What happened to each uploaded file, and the totals.
 *
 * Shared by the erase response and the standalone documents-purge
 * endpoint, because they run the identical operation — erasure just
 * pins `dryRun` to false.
 *
 * The per-item array is contractual rather than a count-only summary
 * because §46's reconciliation step needs the dry-run plan and the real
 * run to be comparable row by row. `FAILED` items in particular have to
 * be nameable: a storage error leaves that one file in place, and the
 * operator answering the data subject needs to know which.
 */
export const documentPurgeResultSchema = z.object({
  /** True when nothing was deleted — this is the plan, not the outcome. */
  dryRun: z.boolean(),
  /** Rows still pointing at a file when the run started. */
  examined: z.number().int(),
  counts: z.object({
    /** Object existed and was removed. */
    deleted: z.number().int(),
    /** Row pointed at an object storage no longer had. A success. */
    alreadyAbsent: z.number().int(),
    /** Stored value was not a `/uploads/` reference we could key. */
    unresolvable: z.number().int(),
    /** Dry run only — what a real run would remove. */
    wouldDelete: z.number().int(),
    /** Storage refused. The row still points at the file; re-run retries. */
    failed: z.number().int(),
  }),
  items: z.array(
    z.object({
      table: z.string(),
      rowId: z.string(),
      column: z.string(),
      key: z.string().nullable(),
      outcome: z.string(),
      error: z.string().optional(),
    }),
  ),
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
  /**
   * Per-file outcome for the uploaded documents.
   *
   * Contractual, not decorative. `retainedTables` used to carry the
   * claim that uploaded KYC files were "cleared separately by retention
   * job" — a job that deleted audit, notification and job-run rows and
   * never touched storage. The files persisted indefinitely while the
   * data subject was told otherwise. This section is the response
   * reporting what was actually deleted instead of promising it.
   */
  documentsPurged: documentPurgeResultSchema,
});

/**
 * POST /compliance/customers/:id/documents-purge — the plan, or the
 * outcome, depending on `dryRun`.
 */
export const documentPurgeResponseSchema = documentPurgeResultSchema.extend({
  ok: z.literal(true),
  customerId: z.string().uuid(),
});
