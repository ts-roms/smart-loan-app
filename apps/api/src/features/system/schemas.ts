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
