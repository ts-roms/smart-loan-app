import { z } from "zod";

/** Tag a customer as Director/Officer/Stockholder/Related-Interest. */
export const tagSchema = z.object({
  customerId: z.string().uuid(),
  category: z.enum(["DIRECTOR", "OFFICER", "STOCKHOLDER", "RELATED_INTEREST"]),
  basis: z.string().min(3).max(500),
});

/** Reason captured on deactivation, kept in the audit trail. */
export const deactivateSchema = z.object({
  reason: z.string().min(3).max(500),
});

/** Preview a proposed loan against the DORSI caps without persisting. */
export const checkSchema = z.object({
  customerId: z.string().uuid(),
  principal: z.number().positive(),
});

/** Board-approval intake when a loan would breach a DORSI cap. */
export const boardApprovalSchema = z.object({
  loanId: z.string().uuid(),
  meetingDate: z.string(),
  minutesRef: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

/** Admin-only update of the company total equity (the cap base). */
export const configUpdateSchema = z.object({
  companyTotalEquity: z.number().nonnegative(),
});

/**
 * Auto-screen body — used at customer onboarding.
 *
 * Validated by the controller via `safeParse`, so the failure shape is
 * the standard `{ error: "ValidationError", issues: [...] }`. The
 * pre-layered route returned `{ error: "ValidationError", message:
 * "name required (>= 2 chars)" }` from an inline guard — the new
 * shape matches every other zod-validated endpoint in the API. If a
 * caller relied on the literal `message` field, that consumer needs
 * an update.
 */
export const screenByNameSchema = z.object({
  name: z.string().min(2).max(200),
});

export type TagInput = z.infer<typeof tagSchema>;
export type DeactivateInput = z.infer<typeof deactivateSchema>;
export type CheckInput = z.infer<typeof checkSchema>;
export type BoardApprovalInput = z.infer<typeof boardApprovalSchema>;
export type ConfigUpdateInput = z.infer<typeof configUpdateSchema>;
