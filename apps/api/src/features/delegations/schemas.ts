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

/** Path param for /:id/preview, /:id/revoke and /:id/extend. */
export const delegationIdParamSchema = z.object({ id: z.string() });

// ─── Response schemas ─────────────────────────────────────────────────

/**
 * A delegation row.
 *
 * `permissions: []` is not "grants nothing" — it is "everything the
 * delegator currently holds", resolved at evaluation time rather than
 * frozen at create. Reading an empty array as an empty grant is the
 * mistake this endpoint invites.
 */
export const delegationResponseSchema = z.object({
  id: z.string().uuid(),
  delegatorId: z.string().uuid(),
  delegateId: z.string().uuid(),
  permissions: z.array(z.string()),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  note: z.string().nullable(),
  /** Non-null means it was cut short; `endsAt` alone does not tell you. */
  revokedAt: z.string().datetime().nullable(),
  revokedById: z.string().uuid().nullable(),
  revokedReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const delegationListResponseSchema = z.array(delegationResponseSchema);

/**
 * GET /delegations — both directions for the caller, kept apart because
 * "authority I handed out" and "authority I was handed" are different
 * questions with different consequences.
 */
export const myDelegationsResponseSchema = z.object({
  granted: delegationListResponseSchema,
  held: delegationListResponseSchema,
});

/**
 * GET /delegations/users/directory — the "delegate to whom" picker.
 * CUSTOMER rows are excluded: a portal account holds only
 * `portal.self`, so it can be neither a useful delegate nor delegator.
 */
export const userDirectoryResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
  }),
);

/**
 * GET /delegations/:id/preview — what this delegation actually grants
 * right now.
 *
 * `droppedPermissions` is the field worth reading: keys the delegation
 * named that the DELEGATOR no longer holds. A non-empty list means the
 * grant quietly stopped delivering what it promised — a role change on
 * the delegator's side that nothing else surfaces.
 */
export const delegationPreviewResponseSchema = z.object({
  delegation: z.object({
    id: z.string().uuid(),
    delegatorId: z.string().uuid(),
    delegateId: z.string().uuid(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    permissions: z.array(z.string()),
    revokedAt: z.string().datetime().nullable(),
  }),
  /** Sorted. What the delegate would inherit if they used it now. */
  resolvedPermissions: z.array(z.string()),
  droppedPermissions: z.array(z.string()),
  /** Not revoked, and now falls inside [startsAt, endsAt]. */
  isActiveNow: z.boolean(),
});
