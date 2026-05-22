import { z } from "zod";

/**
 * Platform-console wire schemas. Distinct from tenant-side schemas:
 * platform actions touch the vendor's control plane (Tenant catalog,
 * license issuance, platform-user management) and never read or write
 * tenant domain data.
 */

export const platformLoginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(1).max(200),
});
export type PlatformLoginInput = z.infer<typeof platformLoginSchema>;

/** URL-safe slug — used as the Postgres schema name. */
export const tenantSlugSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(
    /^[a-z][a-z0-9-]+$/,
    "Lowercase alphanumeric + dashes, must start with a letter",
  );

export const provisionTenantSchema = z.object({
  slug: tenantSlugSchema,
  name: z.string().min(1).max(200),
  /**
   * Email for the bootstrap admin user that gets seeded into the new
   * tenant. Defaults to `admin@<slug>.local` — a reserved TLD, so
   * mail won't accidentally route anywhere. The cooperative admin
   * changes this on first login.
   */
  adminEmail: z.string().email().max(180).optional(),
  /** Display name for the bootstrap admin. Defaults to "Cooperative Admin". */
  adminName: z.string().min(1).max(120).optional(),
});
export type ProvisionTenantInput = z.infer<typeof provisionTenantSchema>;

/** Body for POST /platform/licenses/:jti/revoke. */
export const revokeLicenseSchema = z.object({
  /** Free-form reason recorded in the audit log + on the issued row. */
  reason: z.string().min(1).max(500).optional(),
});
export type RevokeLicenseInput = z.infer<typeof revokeLicenseSchema>;

/** Body for POST /platform/licenses — issue a new license token. */
export const issueLicenseSchema = z.object({
  /** Slug of the tenant this license is for. Embedded as `tenant` in
   * the signed payload. Doesn't have to exist in the Tenant table yet
   * (issuance can come before provisioning). */
  tenantSlug: tenantSlugSchema,
  /** Display name embedded in the token. Falls back to slug if omitted. */
  tenantName: z.string().min(1).max(200).optional(),
  tier: z.enum(["BASIC", "PROFESSIONAL", "ENTERPRISE"]),
  /** ISO date for expiry. Required. */
  expiresAt: z.string().datetime(),
  /** Optional not-before. Defaults to now. */
  notBefore: z.string().datetime().optional(),
  /** Soft seat cap. 0 = unlimited. Defaults to the tier's default. */
  seats: z.number().int().nonnegative().optional(),
  /** Explicit feature list. Defaults to the tier's catalog. */
  features: z.array(z.string()).optional(),
  /** Free-form notes shown on the tenant's /settings/license panel. */
  notes: z.string().max(500).optional(),
});
export type IssueLicenseInput = z.infer<typeof issueLicenseSchema>;
