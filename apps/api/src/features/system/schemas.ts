import { z } from "zod";

/**
 * Bounds for the idle-timeout policy. Below ~15s is unusable in
 * practice (a single Slack notification toggles the tab and dings the
 * counter); above 1h defeats the security intent. The frontend mirrors
 * these bounds in the settings UI.
 */
export const IDLE_TIMEOUT_MIN = 15;
export const IDLE_TIMEOUT_MAX = 3600;
export const IDLE_WARNING_MIN = 10;
export const IDLE_WARNING_MAX = 600;

export const idlePolicyUpdateSchema = z.object({
  idleTimeoutSeconds: z
    .number()
    .int()
    .min(IDLE_TIMEOUT_MIN)
    .max(IDLE_TIMEOUT_MAX),
  idleWarningSeconds: z
    .number()
    .int()
    .min(IDLE_WARNING_MIN)
    .max(IDLE_WARNING_MAX),
});

export type IdlePolicyUpdateInput = z.infer<typeof idlePolicyUpdateSchema>;

/**
 * Branding update. `companyName` is required (sized for the sidebar);
 * every other field is optional. `null` (vs. undefined) is treated as
 * "clear the field" — convenient for the UI to send when a user blanks
 * out an input.
 */
export const brandingUpdateSchema = z.object({
  companyName: z.string().min(1).max(80),
  companyLogoUrl: z.string().max(500).nullable().optional(),
  companyTagline: z.string().max(120).nullable().optional(),
  companyAddress: z.string().max(500).nullable().optional(),
  companyPhone: z.string().max(40).nullable().optional(),
  companyEmail: z.string().email().max(120).nullable().optional(),
  companyWebsite: z.string().max(200).nullable().optional(),
});

export type BrandingUpdateInput = z.infer<typeof brandingUpdateSchema>;

/**
 * Per-tenant notification-provider credentials. Each field nullable
 * (null = "clear it; fall back to the platform provider"). The
 * tenantId-scoped admin pastes credentials from their Twilio /
 * SendGrid dashboards; the platform itself never touches them.
 *
 * On read, secrets are masked (see system.routes.ts → maskSecret).
 * The PUT accepts the secret in plaintext; subsequent GETs return
 * the masked form so the operator can verify "yes, that's the key
 * I pasted" without re-exposing it.
 */
export const notificationProvidersUpdateSchema = z.object({
  twilioAccountSid: z.string().min(20).max(80).nullable().optional(),
  twilioAuthToken: z.string().min(20).max(80).nullable().optional(),
  /** E.164 ("+15551234567") or alphanumeric sender id (3–11 chars). */
  twilioFromNumber: z.string().min(3).max(20).nullable().optional(),
  /** SendGrid keys start with "SG." — minimum length is the prefix
   *  plus the body (varies; ~60 chars typical). */
  sendgridApiKey: z.string().min(10).max(200).nullable().optional(),
  sendgridFromEmail: z.string().email().max(180).nullable().optional(),
  sendgridFromName: z.string().min(1).max(80).nullable().optional(),
});

export type NotificationProvidersUpdateInput = z.infer<
  typeof notificationProvidersUpdateSchema
>;

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts).
 *
 * `SystemConfig` is a singleton row with a Decimal or two on it
 * (`companyTotalEquity`, `renewalMinPaidFraction`) — but none of the
 * routes here `select` them, so the money rule never comes up in this
 * feature. Every response below is a narrow projection of the singleton,
 * and the schemas mirror the handler's `select` rather than the model.
 */

/**
 * GET/PUT /system/idle-policy.
 *
 * `bounds` is not stored — it is the module's own MIN/MAX constants
 * echoed back so the settings UI validates against the same numbers the
 * server enforces instead of hardcoding a second copy. It is therefore
 * on the GET only; the PUT answers the stored fields alone.
 */
export const idlePolicyResponseSchema = z.object({
  idleTimeoutSeconds: z.number().int(),
  idleWarningSeconds: z.number().int(),
  updatedAt: z.string().datetime(),
  bounds: z.object({
    idleTimeoutSeconds: z.object({
      min: z.number().int(),
      max: z.number().int(),
    }),
    idleWarningSeconds: z.object({
      min: z.number().int(),
      max: z.number().int(),
    }),
  }),
});

/** PUT /system/idle-policy — the stored fields, without the bounds. */
export const idlePolicyUpdateResponseSchema = z.object({
  idleTimeoutSeconds: z.number().int(),
  idleWarningSeconds: z.number().int(),
  updatedAt: z.string().datetime(),
});

/**
 * GET/PUT /system/branding — the exact BRANDING_SELECT projection.
 * `companyName` has a column default ("SmartLoan") and is never null;
 * everything else is genuinely unset until an admin fills it in.
 */
export const brandingResponseSchema = z.object({
  companyName: z.string(),
  /** `/uploads/branding/…`. Null = fall back to the built-in glyph. */
  companyLogoUrl: z.string().nullable(),
  companyTagline: z.string().nullable(),
  companyAddress: z.string().nullable(),
  companyPhone: z.string().nullable(),
  companyEmail: z.string().nullable(),
  companyWebsite: z.string().nullable(),
  updatedAt: z.string().datetime(),
});

/**
 * GET /system/notification-providers — the MASKED view.
 *
 * The secrets come back as "AC12…7f9x", never in full: the PUT takes
 * plaintext, and after that the API will only ever confirm the shape of
 * what it holds. That is a deliberate property of this endpoint and the
 * reason the schema says `string` rather than anything more specific —
 * the masked form is not a credential and should not be described as
 * one. Sender numbers and addresses are not secrets and are returned
 * whole.
 */
export const notificationProvidersResponseSchema = z.object({
  /** Masked. Null when unset. */
  twilioAccountSid: z.string().nullable(),
  /** Masked. Null when unset. */
  twilioAuthToken: z.string().nullable(),
  /** Not a secret — returned in full. */
  twilioFromNumber: z.string().nullable(),
  /** Masked. Null when unset. */
  sendgridApiKey: z.string().nullable(),
  /** Not a secret — returned in full. */
  sendgridFromEmail: z.string().nullable(),
  sendgridFromName: z.string().nullable(),
  updatedAt: z.string().datetime(),
  /**
   * Per-provider "is it fully configured" flags, so the UI can show a
   * green check without regex-matching the masked value back.
   */
  configured: z.object({
    twilio: z.boolean(),
    sendgrid: z.boolean(),
  }),
});

/**
 * PUT /system/notification-providers — an acknowledgement, and ONLY
 * that.
 *
 * Worth stating plainly because the handler's own comment claims
 * otherwise: it says it returns the masked view "so the UI can refresh
 * from the response without an extra round-trip", and then sends
 * `{ ok: true }` with an `X-Refresh-Needed: 1` header. The header is
 * the actual mechanism — the client is being told to re-GET, which is
 * the opposite of what the comment describes.
 *
 * This schema follows the CODE. A schema written from that comment
 * would have declared the masked-view shape, passed every test, and
 * published a body this route has never once sent.
 */
export const notificationProvidersUpdateResponseSchema = z.object({
  ok: z.literal(true),
});
