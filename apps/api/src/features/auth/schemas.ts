import {
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
  isValidPhone,
  normalizePhone,
} from "@loan/shared-utils";
import { z } from "zod";

/**
 * A PH phone number: 10 or 11 digits once punctuation and a country
 * code are stripped, stored normalised so "+63 917 123 4567" and
 * "09171234567" are one value rather than two.
 *
 * `transform` runs after the check, so what reaches the repository is
 * always digits — search and duplicate detection depend on that.
 */
const phone = () =>
  z
    .string()
    .refine((v) => isValidPhone(v), {
      message: `Enter a phone number with ${PHONE_MIN_DIGITS} or ${PHONE_MAX_DIGITS} digits`,
    })
    .transform((v) => normalizePhone(v));

/** Same rule, but an empty string passes through as "not given". */
const optionalPhone = () =>
  z
    .string()
    .refine((v) => v.trim() === "" || isValidPhone(v), {
      message: `Enter a phone number with ${PHONE_MIN_DIGITS} or ${PHONE_MAX_DIGITS} digits`,
    })
    .transform((v) => (v.trim() === "" ? "" : normalizePhone(v)));

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

/**
 * Profile completion — the second half of self-registration.
 *
 * `registerSchema` above deliberately asks for almost nothing, so
 * signing up is one short screen. This is where the borrower supplies
 * what a loan file actually requires, and it's mandatory: until it
 * succeeds the account has no linked Customer and every portal route
 * refuses it.
 *
 * The required set is exactly the NOT NULL columns on Customer: legal
 * name, birth date, a contact number, enough of an address to serve a
 * notice to, a government ID, and employment + income. Nothing here is
 * required by choice — a Customer row cannot be inserted without them,
 * so anything omitted would have to be faked with a placeholder, and a
 * fabricated ID number or income figure is worse than an extra field.
 *
 * Everything else the model can hold (spouse details, employer name,
 * hire dates, tenure) stays optional and gets filled in later from the
 * portal profile page or by staff during KYC.
 */
export const completeProfileSchema = z.object({
  // Personal
  firstName: z.string().min(1).max(80),
  middleName: z.string().max(80).optional(),
  lastName: z.string().min(1).max(80),
  suffix: z.string().max(10).optional(),
  /**
   * Date-only (YYYY-MM-DD) rather than a full timestamp — a birth date
   * has no time component, and accepting one invites a timezone shift
   * that moves someone's birthday across midnight.
   */
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .refine((s) => !Number.isNaN(Date.parse(s)), "Not a real date")
    .refine(
      (s) => Date.parse(s) < Date.now(),
      "Date of birth is in the future",
    ),
  civilStatus: z
    .enum(["SINGLE", "MARRIED", "WIDOWED", "SEPARATED", "ANNULLED", "DIVORCED"])
    .optional(),

  // Contact
  phone: phone(),
  secondaryPhone: optionalPhone().optional(),
  /**
   * Optional: the account's login email is used when this is absent.
   * Present so a borrower can route loan correspondence somewhere
   * other than the address they signed in with.
   */
  email: z.string().email().optional(),

  // Address
  address: z.string().min(1).max(200),
  addressLine2: z.string().max(200).optional(),
  barangay: z.string().max(120).optional(),
  city: z.string().min(1).max(120),
  province: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),

  // Government ID
  governmentIdType: z.enum([
    "PASSPORT",
    "DRIVERS_LICENSE",
    "NATIONAL_ID",
    "SSS",
    "TIN",
    "OTHER",
  ]),
  governmentIdNumber: z.string().min(1).max(60),

  // Employment + income
  employmentStatus: z.enum([
    "EMPLOYED",
    "SELF_EMPLOYED",
    "FREELANCE",
    "UNEMPLOYED",
    "RETIRED",
    "STUDENT",
  ]),
  employerName: z.string().max(160).optional(),
  jobTitle: z.string().max(160).optional(),
  /**
   * Non-negative rather than positive: UNEMPLOYED, RETIRED and STUDENT
   * are all valid statuses here, and forcing them to claim income to
   * get past the form would poison the figure underwriting reads.
   */
  monthlyIncome: z.number().nonnegative().max(1_000_000_000),
});

export type CompleteProfileInput = z.infer<typeof completeProfileSchema>;

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

/**
 * Start a reset. Only an email — the response is identical whether it
 * matches an account or not, so there is nothing else to validate.
 */
export const forgotPasswordSchema = z.object({
  email: z.string().email().max(200),
  /** Present on multi-tenant deploys; resolved the same way login is. */
  tenantSlug: z.string().max(64).optional(),
});

/**
 * Redeem one. The password rule matches registration — a reset is not
 * a back door to a weaker password than signup would have accepted.
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(200),
  tenantSlug: z.string().max(64).optional(),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// ─── Response schemas ─────────────────────────────────────────────────
//
// Declared beside the requests they answer, and derived from what the
// controller actually sends rather than from the service's TypeScript
// return types — the two had already drifted once, see `userDigestSchema`.

/** Every role the User table can hold. All six, so the serialiser
 * never meets a value its enum refuses. */
const userRoleSchema = z.enum([
  "ADMIN",
  "LOAN_OFFICER",
  "ACCOUNTANT",
  "COLLECTOR",
  "AGENT",
  "CUSTOMER",
]);

/**
 * The user summary that rides along with a token pair.
 *
 * `customerId` is here because `digest()` in auth.service.ts puts it
 * there — and it is load-bearing, not incidental: a CUSTOMER with a
 * null `customerId` has registered but not completed their profile, and
 * the web app gates the whole borrower portal on exactly this field.
 *
 * Worth naming because the controller's own `tokenResponse` helper
 * types its `user` parameter as `{ id, email, name, role }` with no
 * `customerId` at all. The type understated the payload; the payload is
 * what clients read.
 */
export const userDigestSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  /** Null for staff, and for a borrower who has not completed /me/profile. */
  customerId: z.string().uuid().nullable(),
});

/**
 * Login / register / refresh all answer with this.
 *
 * `token` duplicates `accessToken` for clients that predate the rename.
 * It is documented rather than quietly dropped because it is still what
 * some deployed clients read; new integrations should use `accessToken`.
 */
export const tokenResponseSchema = z.object({
  /** Deprecated alias of `accessToken`. */
  token: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.string().datetime(),
  user: userDigestSchema,
});

/** GET /auth/me — the signed-in account, without anything secret. */
export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
  active: z.boolean(),
  createdAt: z.string().datetime(),
  customerId: z.string().uuid().nullable(),
});

/** POST /auth/me/profile 201 — the login, now linked to a Customer. */
export const completeProfileResponseSchema = z.object({
  user: userDigestSchema,
});

/**
 * GET/PUT/DELETE /auth/me/signature all answer the same pair. DELETE
 * returns it with both fields null rather than a 204, so the client can
 * repaint from the response without a second read.
 */
export const signatureResponseSchema = z.object({
  signatureUrl: z.string().nullable(),
  savedAt: z.string().datetime().nullable(),
});

/**
 * GET /auth/me/permissions. `permissions` is the flattened union of
 * keys across the caller's roles, sorted. The web app hides actions
 * with it; the real gate is always `requirePermission` server-side.
 */
export const permissionsResponseSchema = z.object({
  permissions: z.array(z.string()),
  roles: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      /** Built-in roles cannot be renamed or deleted. */
      system: z.boolean(),
    }),
  ),
});

/**
 * Notification bell state. Shared by GET /me/notifications/state and
 * POST /me/notifications/seen — the POST answers with the same shape,
 * `unseen` reset to 0, so the bell can repaint from the write.
 */
export const notificationsStateResponseSchema = z.object({
  /** Null on an account that has never opened the bell. */
  lastSeenAt: z.string().datetime().nullable(),
  unseen: z.number().int(),
});

export const totpStatusResponseSchema = z.object({
  enabled: z.boolean(),
  recoveryCodesRemaining: z.number().int(),
});

/**
 * POST /auth/me/2fa/setup. `secret` is shown once, for manual entry;
 * `otpauth` is the URI the client renders as a QR code. 2FA is not on
 * until /enable confirms a code derived from this secret.
 */
export const totpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauth: z.string(),
});

/**
 * POST /auth/me/2fa/enable. The recovery codes are returned in clear
 * exactly once — only their hashes are stored, so a client that does
 * not show them here has lost them.
 */
export const totpEnableResponseSchema = z.object({
  enabled: z.boolean(),
  recoveryCodes: z.array(z.string()),
});

/** POST /auth/me/2fa/disable. */
export const totpDisableResponseSchema = z.object({
  enabled: z.boolean(),
});

/**
 * The bare acknowledgement the password-reset routes answer with.
 *
 * Deliberately says nothing else. `/forgot-password` returns it whether
 * or not the address matches an account, which is the entire point of
 * the endpoint's design.
 */
export const okResponseSchema = z.object({
  ok: z.boolean(),
});

/** Path param of GET /auth/reset-password/:token. */
export const resetTokenParamSchema = z.object({
  /**
   * Unconstrained on purpose. Length rules belong to the handler, which
   * answers an unusable link with 410 Gone; a `minLength` here would
   * turn that into a 400 and tell the reset page the wrong story.
   */
  token: z.string(),
});
