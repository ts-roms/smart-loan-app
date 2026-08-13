import { z } from "zod";

/**
 * Create a new payment intent. The provider (currently MOCK only) is
 * fixed per-instance — the route file holds the live provider.
 */
export const createIntentSchema = z.object({
  loanId: z.string().uuid(),
  amount: z.number().positive(),
  description: z.string().max(200).optional(),
  /**
   * Optional. If absent, the route allocates a fresh UUID — meaning
   * each call creates a new intent. Pass a stable key to make the
   * create idempotent (repo deduplicates by `(provider, idempotencyKey)`).
   */
  idempotencyKey: z.string().min(1).max(120).optional(),
});

export type CreateIntentInput = z.infer<typeof createIntentSchema>;

/** GET /payments/intents — the loan filter is required, not optional. */
export const intentListQuerySchema = z.object({
  /**
   * Not `.uuid()`: the handler only needs something to filter on, and a
   * malformed id should come back as an empty list rather than a
   * validation failure about a field the caller cannot see.
   */
  loanId: z.string(),
});

export const intentIdParamSchema = z.object({
  /** Either the UUID or the human "PI-…" number. */
  id: z.string(),
});

/**
 * Webhook and sandbox path params. Every segment is an unconstrained
 * string on purpose: the handlers answer a wrong provider name with
 * 400 and an unknown tenant slug with 404 (so the endpoint cannot be
 * used to enumerate tenants), and a pattern here would pre-empt both
 * with a validation error that says more than either.
 */
export const webhookParamSchema = z.object({ provider: z.string() });

export const webhookTenantParamSchema = webhookParamSchema.extend({
  tenantSlug: z.string(),
});

export const sandboxParamSchema = z.object({ externalId: z.string() });

export const sandboxTenantParamSchema = sandboxParamSchema.extend({
  tenantSlug: z.string(),
});

// ─── Response schemas ─────────────────────────────────────────────────

/**
 * A payment intent as stored.
 *
 * `amount` is a `Decimal` column and therefore a STRING on the wire —
 * the create request takes a number, the response gives it back as
 * text, and an integrator who assumes symmetry gets `"1500.00"` where
 * they expected `1500`.
 */
export const paymentIntentResponseSchema = z.object({
  id: z.string().uuid(),
  /** Human-readable "PI-2026-000123". Also accepted in the URL. */
  number: z.string(),
  loanId: z.string().uuid(),
  provider: z.enum(["MOCK", "GCASH", "MAYA"]),
  /** Provider-side id. Handed to the client, and what the callback names. */
  externalId: z.string(),
  idempotencyKey: z.string(),
  amount: z.string(),
  paymentUrl: z.string(),
  status: z.enum(["CREATED", "PROCESSING", "PAID", "FAILED", "EXPIRED"]),
  /** Set when the status became terminal. */
  resolvedAt: z.string().datetime().nullable(),
  /** The LoanPayment this settled into, once it has been paid. */
  paymentId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdById: z.string().uuid(),
});

export const intentListResponseSchema = z.array(paymentIntentResponseSchema);

/**
 * The gateway callback's answer. `status` is the intent's status AFTER
 * the event was applied; `paymentId` is non-null only on the delivery
 * that actually settled it — a redelivery of the same event answers
 * `ok: true` with null, because the settlement already happened.
 */
export const webhookResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["CREATED", "PROCESSING", "PAID", "FAILED", "EXPIRED"]),
  paymentId: z.string().uuid().nullable(),
});

/**
 * The sandbox confirm endpoint's answer. Same three facts as the
 * webhook, but the status field is named `intentStatus` rather than
 * `status`. Documented as it is, not as it ought to have been — the
 * two shapes have been on the wire long enough to be depended on.
 */
export const sandboxConfirmResponseSchema = z.object({
  ok: z.boolean(),
  intentStatus: z.enum(["CREATED", "PROCESSING", "PAID", "FAILED", "EXPIRED"]),
  paymentId: z.string().uuid().nullable(),
});
