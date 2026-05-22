import { z } from "zod";

/**
 * Borrower-portal wire schemas. The portal is implicitly scoped to the
 * authenticated CUSTOMER user's `customerId`, so none of these
 * payloads carry a customer identifier — the service resolves it from
 * the JWT subject.
 */

/**
 * Borrower self-apply for a loan. Same surface as the officer-mediated
 * `/loans/apply` schema, minus the customerId (we never trust a
 * client-supplied one here).
 */
export const applySchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
  vehicle: z
    .object({
      kind: z.enum(["CAR", "MOTORCYCLE"]),
      make: z.string().min(1).max(80),
      model: z.string().min(1).max(80),
      year: z.number().int().min(1900).max(2100),
      plateNumber: z.string().max(40).optional(),
      chassisNumber: z.string().max(80).optional(),
      engineNumber: z.string().max(80).optional(),
      color: z.string().max(40).optional(),
      appraisedValue: z.number().positive(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  property: z
    .object({
      propertyType: z.string().min(1).max(80),
      address: z.string().min(1).max(500),
      city: z.string().min(1).max(80),
      province: z.string().max(80).optional(),
      postalCode: z.string().max(20).optional(),
      titleNumber: z.string().max(80).optional(),
      taxDecNumber: z.string().max(80).optional(),
      areaSqm: z.number().positive().optional(),
      appraisedValue: z.number().positive(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  applicationSelfieUrl: z.string().max(500).optional(),
});
export type ApplyInput = z.infer<typeof applySchema>;

export const kycSubmitSchema = z.object({
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
export type KycSubmitInput = z.infer<typeof kycSubmitSchema>;

export const intentSchema = z.object({
  loanId: z.string().uuid(),
  amount: z.number().positive(),
});
export type IntentInput = z.infer<typeof intentSchema>;

/** Borrower signature blob (data URL or hosted asset URL). */
export const signSchema = z.object({
  signatureUrl: z.string().min(1),
});
export type SignInput = z.infer<typeof signSchema>;

/**
 * Self-service profile edit allowlist. NAMES, date of birth, gov't ID,
 * employment, income, KYC status — all deliberately absent. Those
 * require either officer re-verification or a dedicated workflow that
 * doesn't exist yet. Refusing the field is safer than letting a
 * borrower silently rewrite their KYC record.
 */
export const profileUpdateSchema = z.object({
  phone: z.string().min(7).max(40).optional(),
  email: z.string().email().max(120).optional().nullable(),
  address: z.string().min(1).max(500).optional(),
  city: z.string().min(1).max(80).optional(),
  province: z.string().max(80).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/** Combined-ledger query shape. */
export const ledgerQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  scope: z.string().optional(),
  format: z.string().optional(),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
