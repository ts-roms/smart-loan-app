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
