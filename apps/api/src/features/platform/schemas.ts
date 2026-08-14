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

/**
 * Body for POST /platform/tenants/:slug/impersonate — mint a short-
 * lived tenant-side JWT so support staff can debug a tenant
 * installation without asking for credentials.
 *
 * `purpose` is required (not optional). The audit trail is the whole
 * point of this endpoint; we don't let people skip explaining why.
 */
export const impersonateTenantSchema = z.object({
  /** Free-form audit note. Stored on both platform and tenant audit
   * logs. Required — impersonation is sensitive enough that the
   * justification must be on the record. */
  purpose: z.string().min(8).max(500),
  /** Token TTL in minutes. Default 15, max 60. Short on purpose —
   * support sessions are short-lived; if you need longer, mint
   * another token. */
  expiresInMin: z.number().int().min(1).max(60).optional(),
  /** Optional: impersonate a specific staff user (by email). If
   * omitted, the first ADMIN user found in the tenant is used.
   * Borrower (CUSTOMER) impersonation is intentionally not
   * supported here. */
  targetUserEmail: z.string().email().max(180).optional(),
});
export type ImpersonateTenantInput = z.infer<typeof impersonateTenantSchema>;

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

/* ─── Request params + query, for the OpenAPI spec ──────────────────────*/

/** `:slug` on every per-tenant route. */
export const tenantSlugParamSchema = z.object({ slug: tenantSlugSchema });

/** `:jti` on the revoke route — the licence's JWT id. */
export const licenseJtiParamSchema = z.object({ jti: z.string().min(1) });

/**
 * `?limit=&tenantSlug=&action=` on the platform audit feed.
 *
 * `limit` is coerced because it arrives as a string. Bounding it here
 * is a real fix rather than only documentation: the handler does
 * `Number(req.query.limit)` with no guard, so `?limit=abc` becomes
 * `NaN` and reaches Prisma as `take: NaN`. The service already caps the
 * value at 500; this rejects the unusable input before it gets there.
 */
export const platformAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  tenantSlug: z.string().optional(),
  action: z.string().optional(),
});

/* ─── Responses ────────────────────────────────────────────────────────
 *
 * No Decimal anywhere in this feature — the four backing models carry
 * only String / Int / Boolean / DateTime / Json — so the usual
 * money-as-string rule never applies here.
 */

/** The platform user, as embedded in the login and impersonate replies. */
const platformUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["PLATFORM_ADMIN", "PLATFORM_SALES"]),
});

/** `POST /platform/auth/login`. */
export const platformLoginResponseSchema = z.object({
  /** Platform JWT. Carries `platform: true`; tenant routes reject it. */
  token: z.string(),
  user: platformUserSchema,
});

/**
 * `GET /platform/me` — read straight off the JWT, no database hit.
 *
 * Note it is NOT the same shape as `login`'s `user`: there is no `name`
 * here, because the token does not carry one.
 */
export const platformMeResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: z.enum(["PLATFORM_ADMIN", "PLATFORM_SALES"]),
});

/**
 * A tenant row, unprojected.
 *
 * `licenseSnapshot` is a cached copy of the tenant's current licence
 * payload, kept so the feature gate does not re-verify a signature on
 * every request. Its shape is the licence payload and it is null before
 * one is activated — declared `z.unknown()` because pinning it here
 * would fork a second description of the licence format.
 */
export const tenantResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.enum(["PROVISIONING", "ACTIVE", "SUSPENDED", "ARCHIVED"]),
  licenseSnapshot: z.unknown(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Last request seen from this tenant; null until one arrives. */
  lastSeenAt: z.string().datetime().nullable(),
  /** Why provisioning failed, when it did. */
  provisioningError: z.string().nullable(),
});

export const tenantListResponseSchema = z.array(tenantResponseSchema);

/**
 * `POST /platform/tenants` — 201, and NOT the full tenant row.
 *
 * A narrowed shape plus the two bootstrap fields, which appear here and
 * nowhere else: `bootstrapPassword` is shown exactly once and is null
 * when an existing admin was reused. There are no timestamps on this
 * response — read the tenant back if you need them.
 */
export const provisionTenantResponseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  /** Shown once. Null when an existing admin was reused. */
  bootstrapPassword: z.string().nullable(),
  bootstrapAdminEmail: z.string().nullable(),
});

/**
 * `POST /platform/tenants/:slug/retry-provisioning`.
 *
 * `status` is always "ACTIVE" on success — the route only answers 200
 * when provisioning completed, and every other outcome is an error
 * status. `bootstrapAdminEmail` is always a string here (it defaults to
 * `admin@<slug>.local`), unlike on the provision response above.
 */
export const retryProvisioningResponseSchema = z.object({
  status: z.string(),
  /** Null when `seedTenant` found an admin already in place. */
  bootstrapPassword: z.string().nullable(),
  bootstrapAdminEmail: z.string(),
});

/**
 * `POST /platform/tenants/:slug/impersonate` — a short-lived TENANT
 * token, minted by the vendor and audited on both sides.
 *
 * `expiresAt` is an ISO string here. That is worth noticing because the
 * upload signer's `expiresAt` on the tenant API is unix milliseconds —
 * same field name, different unit, different feature.
 */
export const impersonateResponseSchema = z.object({
  /** Tenant-side JWT carrying `impersonatedBy`. Default TTL 15 minutes. */
  token: z.string(),
  expiresAt: z.string().datetime(),
  user: z.object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string(),
    /** Staff roles only — CUSTOMER impersonation is refused. */
    role: z.string(),
  }),
});

/**
 * The signed licence payload, as embedded in an issued token.
 *
 * `iat`, `nbf` and `exp` are **unix milliseconds**, not ISO strings —
 * they are JWT-style claims and are compared numerically. `nbf` and
 * `notes` are omitted rather than null when absent.
 */
const licensePayloadSchema = z.object({
  v: z.number().int(),
  jti: z.string(),
  tenant: z.string(),
  tier: z.enum(["BASIC", "PROFESSIONAL", "ENTERPRISE"]),
  features: z.array(z.string()),
  /** Unix ms. */
  iat: z.number(),
  /** Unix ms. Omitted when the licence has no not-before. */
  nbf: z.number().optional(),
  /** Unix ms. */
  exp: z.number(),
  /** 0 means unlimited. */
  seats: z.number().int(),
  notes: z.string().optional(),
});

/** `POST /platform/licenses` — 201. The token is the deliverable. */
export const issueLicenseResponseSchema = z.object({
  /** The signed licence. Hand this to the tenant to activate. */
  token: z.string(),
  payload: licensePayloadSchema,
});

/**
 * `GET /platform/tenants/:slug/licenses` — issuance history.
 *
 * Note `token` is included on every row: the full signed licence is
 * re-readable here, which is what lets an operator resend one without
 * re-issuing it.
 */
export const tenantLicenseListResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    jti: z.string(),
    tenantSlug: z.string(),
    tenantName: z.string(),
    tier: z.string(),
    /** The full signed licence, re-readable so it can be resent. */
    token: z.string(),
    /** The payload as persisted; same shape as an issued licence. */
    payload: z.unknown(),
    issuedAt: z.string().datetime(),
    notBefore: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
    seats: z.number().int(),
    notes: z.string().nullable(),
    issuedById: z.string().uuid(),
    issuedByEmail: z.string(),
    revokedAt: z.string().datetime().nullable(),
    revokedById: z.string().uuid().nullable(),
    revokedReason: z.string().nullable(),
  }),
);

/**
 * `POST /platform/licenses/:jti/revoke`.
 *
 * `ok` is on the wire because the handler returns the service's
 * discriminated-union member verbatim. `clearedSnapshot` says whether
 * the tenant's cached `licenseSnapshot` was also wiped — it is false
 * when the revoked licence was not the active one.
 */
export const revokeLicenseResponseSchema = z.object({
  ok: z.boolean(),
  jti: z.string(),
  clearedSnapshot: z.boolean(),
});

/**
 * `GET /platform/audit` — the vendor-side trail, newest first.
 *
 * Separate from the tenant `/audit` feed and a different shape: this
 * one records what VENDOR staff did (provisioning, licence issuance,
 * impersonation), and its actor is a platform user.
 */
export const platformAuditResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    action: z.string(),
    actorId: z.string().uuid(),
    actorEmail: z.string(),
    /** Null for actions not scoped to one tenant. */
    tenantSlug: z.string().nullable(),
    /** Action-specific detail; shape varies with `action`. */
    payload: z.unknown(),
    createdAt: z.string().datetime(),
  }),
);
