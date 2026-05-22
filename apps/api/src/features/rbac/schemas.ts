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
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(200).optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const assignSchema = z.object({
  roleKey: z.string().min(1),
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
