import { z } from "zod";

/**
 * RBAC admin schemas. Owners are the routes that admin the permission
 * catalog, role definitions, user records, and role assignments. The
 * shapes here are wire-format only — segregation, self-lockout, and
 * customer-link rules live in the service.
 */

/** Role keys are UPPER_SNAKE_CASE — by convention everywhere in code. */
export const roleKeySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]+$/, "Key must be UPPER_SNAKE_CASE");
export type RoleKey = z.infer<typeof roleKeySchema>;

export const createRoleSchema = z.object({
  key: roleKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(200).optional(),
  /**
   * Optional inheritance: each entry is a role key whose permissions
   * the new role will inherit. Cycle detection runs in the service.
   * Empty array or omitted = standalone role.
   */
  parents: z.array(z.string()).max(20).optional(),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(200).optional(),
  parents: z.array(z.string()).max(20).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const assignSchema = z.object({
  roleKey: z.string().min(1),
  /**
   * Optional ISO-8601 timestamp at which this assignment stops granting
   * permissions. Omitting (or sending null) means perpetual — the
   * historical default. Past dates are accepted at the wire level but
   * the service rejects them so the API never silently records a
   * "born expired" grant.
   */
  expiresAt: z.string().datetime().nullable().optional(),
});
export type AssignRoleInput = z.infer<typeof assignSchema>;

/**
 * Body for POST /admin/roles/:key/edit-impact — the safety-net dialog
 * preview before saving a role-permission change. Same `permissions`
 * shape as the create/update schemas.
 */
export const editImpactSchema = z.object({
  permissions: z.array(z.string()).max(200),
});
export type EditImpactInput = z.infer<typeof editImpactSchema>;

/**
 * Body for PATCH /admin/permissions/:key — currently only the status
 * field is mutable from this endpoint. Labels + descriptions are
 * authoritative in code seed and not editable here.
 */
export const permissionPatchSchema = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "DEPRECATED"]),
});
export type PermissionPatchInput = z.infer<typeof permissionPatchSchema>;

/**
 * Bulk user import. CSV-ish: an array of opaque row objects + flags.
 * Mirrors the customers bulk-import shape so the UI can reuse the
 * existing CSV-parsing utilities. Per-row zod validation runs in
 * the service against `bulkUserRowSchema` (below).
 */
export const userBulkImportSchema = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(500),
  stopOnError: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
});
export type UserBulkImportInput = z.infer<typeof userBulkImportSchema>;

/**
 * Per-row schema applied to each entry inside `userBulkImportSchema.rows`.
 * Same fields as `createUserSchema` plus an optional comma-or-array
 * list of secondary role keys to assign post-create. Operators
 * commonly want to set the primary role + add 1-2 extras in one go.
 */
export const bulkUserRowSchema = z.object({
  email: z.string().email().max(120),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
  role: z.enum(["ADMIN", "LOAN_OFFICER", "ACCOUNTANT", "CUSTOMER"]),
  customerId: z.string().uuid().optional(),
  /**
   * Optional secondary role keys. Accepts either a comma-separated
   * string (typical CSV cell) or an explicit array. Filtered + trimmed
   * before assignment.
   */
  extraRoles: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return [] as string[];
      const list = Array.isArray(v) ? v : v.split(",");
      return list.map((s) => s.trim()).filter((s) => s.length > 0);
    }),
});
export type BulkUserRowInput = z.infer<typeof bulkUserRowSchema>;

/**
 * Admin-side user creation. The public /auth/register endpoint creates
 * CUSTOMER-only users and is rate-limited; this lets an ADMIN onboard
 * any primary role (including another ADMIN).
 */
export const createUserSchema = z.object({
  email: z.string().email().max(120),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
  role: z.enum(["ADMIN", "LOAN_OFFICER", "ACCOUNTANT", "CUSTOMER"]),
  /** When the role is CUSTOMER, link to an existing customer row. */
  customerId: z.string().uuid().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Ending a user's sessions. The only field is the reason, and it's
 * optional because an incident is a bad moment to make someone fill in
 * a form — but the audit row is worth far more with it, so the UI asks.
 */
/**
 * Status change. The reason is optional for the same reason
 * force-logout's is — an offboarding at 5pm on a Friday shouldn't
 * stall on a text field — but it's what makes the audit row answer
 * "why is this account off" a year later.
 */
export const setUserActiveSchema = z.object({
  active: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
export type SetUserActiveInput = z.infer<typeof setUserActiveSchema>;

export const forceLogoutSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type ForceLogoutInput = z.infer<typeof forceLogoutSchema>;

// ─── Path params ──────────────────────────────────────────────────────
//
// Unconstrained strings. A `roleKeySchema` here would answer a lookup
// for a lowercase key with 400 "must be UPPER_SNAKE_CASE" instead of
// the 404 the handler sends, and 404 is the honest answer to "no such
// role" regardless of how the caller spelled it.

export const permissionKeyParamSchema = z.object({ key: z.string() });
export const roleKeyParamSchema = z.object({ key: z.string() });
export const userIdParamSchema = z.object({ userId: z.string() });
export const userRoleParamSchema = z.object({
  userId: z.string(),
  roleKey: z.string(),
});

// ─── Response schemas ─────────────────────────────────────────────────

/** One row of the permission catalog, as stored. */
export const permissionResponseSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  /** UI grouping — "Loans", "Accounting", … */
  category: z.string(),
  /** System permissions are code-referenced and cannot be deleted. */
  system: z.boolean(),
  /**
   * DRAFT is not granted by the resolver; DEPRECATED still is, so
   * in-flight workflows keep working while admins plan its removal.
   */
  status: z.enum(["DRAFT", "ACTIVE", "DEPRECATED"]),
  createdAt: z.string().datetime(),
});

export const permissionListResponseSchema = z.array(permissionResponseSchema);

/** A role row on its own — what create / update / delete answer with. */
export const roleResponseSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** The canonical roles. Editable, but never deletable. */
  system: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * A role with its permission set and inheritance parents, as the
 * repository's `include` shapes them: each entry is the join row, so
 * the payload is `permissions[].permission` rather than a flat list.
 * Documented as it is sent rather than as it would be nicer.
 */
export const roleDetailResponseSchema = roleResponseSchema.extend({
  permissions: z.array(z.object({ permission: permissionResponseSchema })),
  parents: z.array(z.object({ parent: roleResponseSchema })),
});

/** GET /admin/roles — the detail shape plus a membership count. */
export const roleListResponseSchema = z.array(
  roleDetailResponseSchema.extend({
    _count: z.object({ users: z.number().int() }),
  }),
);

/** POST /admin/sync — idempotent re-seed counts for both catalogs. */
export const syncResponseSchema = z.object({
  permissions: z.object({
    created: z.number().int(),
    existing: z.number().int(),
  }),
  roles: z.object({
    created: z.number().int(),
    existing: z.number().int(),
  }),
});

/**
 * GET /admin/permissions/:key/holders — "who holds this permission?",
 * split by how they got it.
 *
 * `delegations` covers stand-in authority, and `viaExplicit` is the
 * part worth reading: false means the delegation grants everything the
 * delegator holds and happens to include this key today, so it
 * disappears the moment the delegator loses it.
 */
export const permissionHoldersResponseSchema = z.object({
  permission: z.object({
    key: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    category: z.string(),
  }),
  directRoles: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      system: z.boolean(),
      userCount: z.number().int(),
    }),
  ),
  delegations: z.array(
    z.object({
      id: z.string().uuid(),
      delegatorId: z.string().uuid(),
      delegatorName: z.string(),
      delegateId: z.string().uuid(),
      delegateName: z.string(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      viaExplicit: z.boolean(),
    }),
  ),
  /** Distinct people, not grants — role holders and delegates deduped. */
  totalActiveUsers: z.number().int(),
});

/**
 * POST /admin/roles/:key/edit-impact — the pre-flight for a role edit.
 *
 * `usersLosing` counts only people for whom this role is the ONLY
 * grant of that key; someone who holds it through a second role is not
 * affected and is deliberately not counted.
 */
export const roleEditImpactResponseSchema = z.object({
  role: z.object({
    key: z.string(),
    name: z.string(),
    system: z.boolean(),
  }),
  removed: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      usersLosing: z.number().int(),
    }),
  ),
  /** Keys the edit adds. No risk count — adding is additive. */
  addedKeys: z.array(z.string()),
});

/**
 * GET /admin/users. `presence` is resolved server-side against one
 * clock rather than sent as a raw timestamp for each browser to judge
 * — a viewer's laptop running ten minutes fast would otherwise show
 * the whole company as offline.
 */
export const userListResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string(),
    /** The legacy `User.role` enum, distinct from the role assignments. */
    primaryRole: z.string(),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    lastSeenAt: z.string().datetime().nullable(),
    /** NEVER is "has not signed in", distinct from OFFLINE. */
    presence: z.enum(["ONLINE", "OFFLINE", "NEVER"]),
    /** Whether there is a live session to end. Never signed in, or
     * already signed out, means force-logout would be a no-op. */
    hasActiveSession: z.boolean(),
    roles: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        system: z.boolean(),
        /**
         * Expired assignments are still listed. The resolver ignores
         * them, but the UI shows "expired 3 days ago" rather than
         * pretending the grant never happened.
         */
        expiresAt: z.string().datetime().nullable(),
      }),
    ),
  }),
);

/** POST /admin/users 201 — the narrowed select the service returns. */
export const userCreatedResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  active: z.boolean(),
  createdAt: z.string().datetime(),
  customerId: z.string().uuid().nullable(),
});

/** One user↔role grant. `expiresAt` null means perpetual. */
export const roleAssignmentResponseSchema = z.object({
  userId: z.string().uuid(),
  roleId: z.string().uuid(),
  grantedAt: z.string().datetime(),
  grantedById: z.string().uuid().nullable(),
  expiresAt: z.string().datetime().nullable(),
});

/** GET /admin/users/:userId/roles — grants with the role row attached. */
export const userRoleListResponseSchema = z.array(
  roleAssignmentResponseSchema.extend({ role: roleResponseSchema }),
);

/** DELETE /admin/users/:userId/roles/:roleKey. */
export const okResponseSchema = z.object({ ok: z.boolean() });

/**
 * PATCH /admin/users/:userId/active.
 *
 * `revokedAt` is non-null only on a deactivation: disabling an account
 * has to cut the sessions already in flight, not merely refuse the next
 * login. Re-enabling leaves the historical cutoff alone, so it answers
 * null with `refreshTokensRevoked: 0`. An already-in-state request is
 * idempotent and answers the same way — no write, no audit row.
 */
export const setUserActiveResponseSchema = z.object({
  ok: z.boolean(),
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  active: z.boolean(),
  revokedAt: z.string().datetime().nullable(),
  refreshTokensRevoked: z.number().int(),
});

/**
 * POST /admin/users/:userId/force-logout. Ends sessions; does NOT
 * disable the account — the user can sign straight back in, which is
 * the point. `refreshTokensRevoked: 0` is normal, not a failure.
 */
export const forceLogoutResponseSchema = z.object({
  ok: z.boolean(),
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  revokedAt: z.string().datetime(),
  refreshTokensRevoked: z.number().int(),
});

/**
 * POST /admin/users/bulk-import 207. Partial success is the expected
 * mode: a failed row does not roll back the ones before it. `id` is
 * absent on a dry run because nothing was created.
 */
export const userBulkImportResponseSchema = z.object({
  results: z.array(
    z.object({
      /** Index into the submitted rows, so failures map back to lines. */
      index: z.number().int(),
      ok: z.boolean(),
      id: z.string().uuid().optional(),
      email: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
  dryRun: z.boolean(),
});
