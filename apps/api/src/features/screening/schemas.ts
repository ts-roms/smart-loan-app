import { z } from "zod";

/**
 * AML screening schemas.
 *
 * The request shapes moved here from the routes file when the responses
 * were documented — same §80 split every other feature uses, so the
 * wire format for a route lives in one place rather than half inline
 * and half beside it.
 *
 * Each screen appends an `AmlScreening` row; the newest row for a
 * customer IS the current status. An override is stored as another row
 * (status `OVERRIDDEN`) rather than a mutation, so the trail of who
 * cleared whom survives.
 */

/** Officer's justification for clearing a customer despite a match. */
export const overrideSchema = z.object({
  note: z.string().min(1).max(500),
});
export type OverrideInput = z.infer<typeof overrideSchema>;

/** A row for the mock provider's watchlist. */
export const watchlistSchema = z.object({
  list: z.string().min(1).max(40),
  fullName: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).max(20).optional(),
  reason: z.string().max(500).optional(),
});
export type WatchlistInput = z.infer<typeof watchlistSchema>;

/** `:customerId` on the per-customer screening routes. */
export const customerIdParamSchema = z.object({
  customerId: z.string().uuid(),
});

/** `:id` on the watchlist delete. */
export const watchlistIdParamSchema = z.object({ id: z.string().uuid() });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts). Nothing in this feature is money, so the Decimal
 * rule does not bite here — the one judgement call is `matches`, below.
 */

/**
 * Where a customer stands with the watchlists. `OVERRIDDEN` is not a
 * provider verdict — it is an officer's decision recorded as one, which
 * is why it shares the enum.
 */
const amlStatusSchema = z.enum([
  "PENDING",
  "CLEAR",
  "MATCH",
  "REVIEW",
  "OVERRIDDEN",
]);

/**
 * One screening attempt, as stored.
 *
 * `matches` is a Prisma `Json?` column holding the provider's hit list
 * — shaped `{ list, name, score, details }[]` by the mock provider, and
 * whatever a real vendor returns once one is wired in. Declared
 * `z.unknown()` on purpose (same call as `loan-products.rateByTier`):
 * naming a shape here would be this file inventing a contract the
 * provider does not owe, and — because Fastify serialises against the
 * schema — would strip any field a future vendor added.
 */
export const screeningResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  status: amlStatusSchema,
  /** Which provider ran it. "MOCK" until a vendor is wired in. */
  provider: z.string(),
  /** The provider's own reference for this screen, when it gives one. */
  providerRef: z.string().nullable(),
  /** Provider hit list. Shape is the provider's, not ours — see above. */
  matches: z.unknown().nullable(),
  /** The officer's justification, on an OVERRIDDEN row. */
  notes: z.string().nullable(),
  screenedAt: z.string().datetime(),
  overriddenById: z.string().nullable(),
  overriddenAt: z.string().datetime().nullable(),
});

/** Every screen for one customer, newest first. */
export const screeningListResponseSchema = z.array(screeningResponseSchema);

/** One watchlist row. */
export const watchlistEntryResponseSchema = z.object({
  id: z.string().uuid(),
  /** "PEP", "SANCTIONS", "ADVERSE_MEDIA", "INTERNAL". */
  list: z.string(),
  fullName: z.string(),
  aliases: z.array(z.string()),
  /** Context for the officer reviewing a match against this row. */
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
});

/** The whole watchlist, alphabetical by name. */
export const watchlistListResponseSchema = z.array(
  watchlistEntryResponseSchema,
);
