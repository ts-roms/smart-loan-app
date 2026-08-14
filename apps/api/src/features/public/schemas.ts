import { z } from "zod";

/**
 * Wire schemas for the anonymous /public/* surface.
 *
 * These endpoints take no auth — they're called from the marketing
 * site by anyone with a browser. Validation is therefore tighter than
 * inside the tenant API: every field is length-capped, every enum is
 * an exact match, and the source field is constrained to a known set
 * so we can group leads by where they came from.
 */

export const captureLeadSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(180),
  cooperative: z.string().min(1).max(200),
  /** Optional. Helps sales recommend a tier without asking. */
  memberCount: z.number().int().min(0).max(1_000_000).optional(),
  /** Hard choice — sales triages these differently. */
  deploymentInterest: z.enum(["ONPREM", "HOSTED", "BOTH"]),
  /** Free-form. 1000 char cap so a spam paste can't blow up the row. */
  message: z.string().max(1000).optional(),
  /**
   * Where the lead came from on the marketing site. Lets sales see
   * "10 leads from /pricing this week" without parsing referrer
   * headers. Free-form but bounded so it can be safely surfaced in
   * dashboards.
   */
  source: z.string().max(40).optional(),
});
export type CaptureLeadInput = z.infer<typeof captureLeadSchema>;

/**
 * Self-service cooperative signup. Provisions a real tenant: a
 * Postgres schema, a full migration run, seeded reference data, and a
 * bootstrap admin account.
 *
 * Because one anonymous request does all of that, the field set is
 * deliberately narrow — a slug, a display name, and who to hand the
 * admin account to. Everything else about the installation (branch
 * details, products, staff) is configured after signing in.
 */
export const signupTenantSchema = z.object({
  /**
   * Becomes the Postgres schema name (`tenant_<slug>`) and the login
   * URL's `?tenant=` value, so it's permanent and visible. Same regex
   * the platform console enforces — kept in sync deliberately: a slug
   * accepted here and rejected there would be a schema that exists but
   * can't be administered.
   */
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(
      /^[a-z][a-z0-9-]+$/,
      "Lowercase letters, numbers and dashes; must start with a letter",
    )
    /**
     * Reserved words that would collide with existing routes or with
     * Postgres' own schemas. `public` in particular holds the Tenant
     * catalog — provisioning over it would be unrecoverable.
     */
    .refine(
      (s) => !["public", "platform", "admin", "api", "www"].includes(s),
      "That name is reserved. Pick another.",
    ),
  name: z.string().min(1).max(200),
  /**
   * Real address, unlike the platform console's optional
   * `admin@<slug>.local` default — this is the only way the person
   * signing up gets their credentials, so it can't be a placeholder.
   */
  adminEmail: z.string().email().max(180),
  adminName: z.string().min(1).max(120),
});
export type SignupTenantInput = z.infer<typeof signupTenantSchema>;

/**
 * Body for the confirmation step. The token is 32 random bytes as hex,
 * so the length is fixed — a bound here keeps anything absurd from
 * reaching the hash function.
 */
export const confirmSignupSchema = z.object({
  token: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/, "Malformed token"),
});
export type ConfirmSignupInput = z.infer<typeof confirmSignupSchema>;

/* ─── Responses ────────────────────────────────────────────────────────*/

/**
 * `POST /public/leads` — deliberately says almost nothing.
 *
 * `{ ok: true }` and no id. The endpoint is anonymous and rate-limited,
 * and echoing a record identifier back to an unauthenticated caller
 * would hand them a handle on a row they have no other way to reach.
 */
export const captureLeadResponseSchema = z.object({ ok: z.boolean() });

/**
 * `POST /public/signup` — 202 Accepted, because nothing is provisioned yet.
 *
 * The status is the contract: a tenant has NOT been created at this
 * point. A confirmation link has been mailed to `adminEmail` and it
 * lapses at `expiresAt` (24h). **No token appears in this response** —
 * it only ever travels by mail, which is the entire reason signup is
 * two steps.
 */
export const signupResponseSchema = z.object({
  ok: z.boolean(),
  /** Trimmed and lower-cased; the address the link was sent to. */
  adminEmail: z.string(),
  expiresAt: z.string().datetime(),
});

/**
 * `POST /public/signup/confirm` — 201, the tenant now exists.
 *
 * `bootstrapPassword` is shown ONCE and never again; it is null when
 * provisioning reused an admin that already existed. `licensed` is
 * false when the trial licence could not be issued — the tenant is
 * still usable, it just starts without one.
 */
export const confirmSignupResponseSchema = z.object({
  ok: z.boolean(),
  slug: z.string(),
  name: z.string(),
  adminEmail: z.string(),
  /** Shown once. Null when an existing admin was reused. */
  bootstrapPassword: z.string().nullable(),
  licensed: z.boolean(),
});
