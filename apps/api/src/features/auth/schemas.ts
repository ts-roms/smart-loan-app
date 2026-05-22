import { z } from "zod";

/** Tenant slug — same regex as the platform-side schema. */
const tenantSlugField = z
  .string()
  .min(2)
  .max(40)
  .regex(
    /^[a-z][a-z0-9-]+$/,
    "Lowercase alphanumeric + dashes, must start with a letter",
  )
  .optional();

/**
 * Login. `totpCode` is required when the user has 2FA on; `recoveryCode`
 * is a single-use escape hatch when the authenticator app is lost.
 *
 * `tenantSlug` is optional in single-tenant mode (server falls back to
 * the default) and effectively required in multi-tenant mode — the
 * tenant resolver in auth.routes rejects requests where it's missing
 * AND the deployment is multi-tenant.
 */
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: tenantSlugField,
  totpCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  recoveryCode: z.string().min(1).max(40).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Public self-register — creates a CUSTOMER row. Staff accounts are
 * created through the rbac admin endpoints, not here.
 */
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120),
  tenantSlug: tenantSlugField,
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(200),
  /**
   * Refresh tokens are tenant-scoped (RefreshToken rows live in the
   * tenant's schema). The client carries the slug it got from login
   * and replays it here so the server knows which schema to look in.
   */
  tenantSlug: tenantSlugField,
});

export type RefreshInput = z.infer<typeof refreshSchema>;

export const saveSignatureSchema = z.object({
  /** URL returned by /uploads-api/signatures upload. */
  signatureUrl: z.string().min(1).max(500),
});

export type SaveSignatureInput = z.infer<typeof saveSignatureSchema>;

/** Body for /me/2fa/enable + /me/2fa/disable (same shape). */
export const totpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "6-digit code required"),
});

export type TotpCodeInput = z.infer<typeof totpCodeSchema>;
