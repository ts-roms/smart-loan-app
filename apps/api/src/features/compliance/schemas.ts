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
