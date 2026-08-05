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
