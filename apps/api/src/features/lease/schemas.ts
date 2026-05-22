import { z } from "zod";

/**
 * Lease-to-Own request schemas. Agreements are created automatically
 * when `LoanRepository.disburse` runs against a lease product, so there
 * is no create endpoint — only state transitions (buyout, pull-out,
 * return, extend) and reads.
 */

/** `?status=...` filter on the index endpoint. */
export const listQuerySchema = z.object({
  status: z
    .enum(["ACTIVE", "PULLED_OUT", "BUYOUT_COMPLETED", "RETURNED", "EXTENDED"])
    .optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** Borrower paid the buyout price and is keeping the unit. */
export const buyoutSchema = z.object({
  amountPaid: z.number().positive(),
});
export type BuyoutInput = z.infer<typeof buyoutSchema>;

/** Repossession path — required reason for the audit trail. */
export const pullOutSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type PullOutInput = z.infer<typeof pullOutSchema>;

/**
 * Shared shape for the "return" and "extend" terminal-state writes.
 * Both demand a reason; the distinction lives in the route + audit
 * action, not the body.
 */
export const closeSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type CloseInput = z.infer<typeof closeSchema>;
