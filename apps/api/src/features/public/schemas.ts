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
