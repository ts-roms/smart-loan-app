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
