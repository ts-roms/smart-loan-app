import { z } from "zod";

/**
 * The co-maker's answer.
 *
 * A decline reason is required, not optional: a declined co-maker
 * blocks disbursement, and the officer's next move depends entirely on
 * why — "I never agreed to this" and "I want a smaller amount" lead
 * somewhere different.
 */
export const respondSchema = z
  .object({
    decision: z.enum(["APPROVED", "DECLINED"]),
    declineReason: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "DECLINED" && !v.declineReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declineReason"],
        message: "Tell us why you're declining.",
      });
    }
  });

export const documentSchema = z.object({
  documentType: z.enum([
    "ID_FRONT",
    "ID_BACK",
    "PROOF_OF_INCOME",
    "PROOF_OF_ADDRESS",
    "SELFIE",
    "VEHICLE_OR",
    "VEHICLE_CR",
    "PROPERTY_TITLE",
    "TAX_DECLARATION",
  ]),
  /** Produced by /uploads-api — see the routes file for why not a file. */
  documentUrl: z.string().min(1).max(500),
});

export type RespondInput = z.infer<typeof respondSchema>;
export type DocumentInput = z.infer<typeof documentSchema>;
