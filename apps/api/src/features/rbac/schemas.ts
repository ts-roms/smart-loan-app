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
