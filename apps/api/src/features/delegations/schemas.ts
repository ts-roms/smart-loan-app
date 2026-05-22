import { z } from "zod";

/**
 * Delegation request schemas.
 *
 * `permissions` is an array of permission keys (e.g. "loans.decide").
 * Empty array = "all of the delegator's current permissions" — copied
 * at evaluation time, not at create time, so permission changes
 * propagate automatically. The service enforces that any explicitly
 * listed key must be one the delegator currently holds.
 */
export const createSchema = z.object({
  delegateId: z.string().uuid(),
  /**
   * Optional. If omitted the caller is the delegator. If set to a
   * different user id, the caller must hold `admin.users` to delegate
   * on someone else's behalf.
   */
  delegatorId: z.string().uuid().optional(),
  permissions: z.array(z.string()).max(200).default([]),
  startsAt: z.string(),
  endsAt: z.string(),
  note: z.string().max(500).optional(),
});
export type CreateDelegationInput = z.infer<typeof createSchema>;

export const revokeSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type RevokeDelegationInput = z.infer<typeof revokeSchema>;

/**
 * Extend an active delegation's end date. Refuses to shorten — that's
 * a different action with its own audit story (revoke + recreate).
 */
export const extendSchema = z.object({
  endsAt: z.string().datetime(),
});
export type ExtendDelegationInput = z.infer<typeof extendSchema>;
