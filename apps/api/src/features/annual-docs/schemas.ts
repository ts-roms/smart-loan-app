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
