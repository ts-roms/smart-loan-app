import { z } from "zod";

/**
 * Wire schema for POST /kyc — submit a document for verification.
 *
 * The documentType enum is hand-mirrored from Prisma's KycDocumentType.
 * Keep this list in sync with libs/db/prisma/schema.prisma — zod can't
 * introspect Prisma types.
 */
export const submitSchema = z.object({
  customerId: z.string().uuid(),
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
  documentUrl: z.string().min(1),
  notes: z.string().max(500).optional(),
});

export type SubmitKycInput = z.infer<typeof submitSchema>;

/**
 * Wire schema for POST /kyc/:id/decide — officer flips a submission
 * to VERIFIED / REJECTED with an optional reason for the audit trail.
 */
export const decisionSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().max(500).optional(),
});

export type DecideKycInput = z.infer<typeof decisionSchema>;
