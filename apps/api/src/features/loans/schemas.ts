import { z } from "zod";

/**
 * Zod schemas for the loans surface. Extracted from loans.routes.ts so
 * the route file stays focused on HTTP wiring; the validation contract
 * lives here and can be unit-tested or reused (e.g. by a future
 * bulk-loan importer) without dragging the whole route file along.
 *
 * Each export is named after the action it gates so the call-site
 * reads naturally: `applySchema.safeParse(req.body)`.
 */

// ─── Collateral sub-schemas ─────────────────────────────────────────────

/**
 * Vehicle collateral. Bound on the same shape the Prisma `Vehicle`
 * model exposes; the route layer hands this directly to the repository.
 */
export const vehicleSchema = z.object({
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
});

/** Real-property collateral (TCT-bound or tax-dec-only). */
export const propertySchema = z.object({
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
});

// ─── Loan workflow ──────────────────────────────────────────────────────

/**
 * Apply for a new loan. `applicationSelfieUrl` is captured at apply
 * time (uploaded via /uploads-api/selfies) and embedded in the
 * agreement PDF for face-match.
 */
/**
 * Query-string for GET /loans. Every field optional — the bare endpoint
 * keeps returning the 200 most recent.
 *
 * `page` and `pageSize` are coerced because query strings are always
 * text, and are left loosely bounded here because the repository clamps
 * them anyway: a stale `?page=0` bookmark should land on page 1, not on
 * a 400.
 */
export const loanListQuerySchema = z.object({
  /** Free text over the loan number and the borrower's name / reference. */
  q: z.string().max(120).optional(),
  status: z
    .enum([
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
      "REJECTED",
      "DISBURSED",
      "ACTIVE",
      "CLOSED",
      "DEFAULTED",
      "CANCELLED",
      "RESTRUCTURED",
      "WRITTEN_OFF",
    ])
    .optional(),
  productCode: z.string().max(40).optional(),
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});
export type LoanListQuery = z.infer<typeof loanListQuerySchema>;

export const applySchema = z.object({
  customerId: z.string().uuid(),
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
  vehicle: vehicleSchema.optional(),
  property: propertySchema.optional(),
  applicationSelfieUrl: z.string().max(500).optional(),
  /**
   * The pre-assessment this application came out of, if any. Linking is
   * best-effort and never blocks the apply — see LoanWorkflowService.
   */
  preAssessmentId: z.string().uuid().optional(),
  /**
   * Answers to the product's KYC declaration questionnaire, keyed by
   * question id. Partial is fine — completeness gates APPROVAL, not
   * submission — but every answer present must fit its question's type
   * (validated in the service against the product's questions).
   */
  kycAnswers: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
});

/** Body of PUT /loans/:id/declarations — the KYC-stage answer/edit. */
export const declarationAnswersSchema = z.object({
  answers: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type DeclarationAnswersInput = z.infer<typeof declarationAnswersSchema>;

export const decideSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  reason: z.string().max(500).optional(),
  overrideKyc: z.boolean().optional(),
});

/** Single payment against a loan. `paidOn` defaults to today server-side. */
export const paymentSchema = z.object({
  amount: z.number().positive(),
  paidOn: z.string().optional(),
  reference: z.string().max(120).optional(),
});

/**
 * Bulk-payment row. Either `loanId` (UUID) or `loanNumber` (LN-…) must
 * be present — the route handler resolves the human number to a UUID
 * before posting.
 */
const bulkPaymentRowSchema = z
  .object({
    loanNumber: z.string().optional(),
    loanId: z.string().uuid().optional(),
    amount: z.number().positive(),
    paidOn: z.string().optional(),
    reference: z.string().max(120).optional(),
  })
  .refine((r) => Boolean(r.loanId || r.loanNumber), {
    message: "Each row needs loanId or loanNumber",
    path: ["loanNumber"],
  });

export const bulkPaymentSchema = z.object({
  rows: z.array(bulkPaymentRowSchema).min(1).max(500),
  stopOnError: z.boolean().optional(),
});

/** Pre-termination settlement. */
export const closeEarlySchema = z.object({
  settlementAmount: z.number().positive(),
  reference: z.string().max(120).optional(),
});

/** Restructure: settle the original and create a replacement loan. */
export const restructureSchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive(),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
});

/** Officer waiver of late-fee / penalty. */
export const waivePenaltySchema = z.object({
  waivedAmount: z.number().positive(),
  reason: z.string().min(3).max(500),
});

/** Write-off — reason is required for the audit trail. */
export const writeOffSchema = z.object({
  reason: z.string().min(1).max(500),
});

/**
 * Loan sign-off. Caller uploads to /uploads-api/signatures first, then
 * posts the resulting URL here. Optional `delegationId` lets a proxy
 * sign on behalf of an absent officer; the delegation must be active
 * and either blanket or explicitly include `loans.sign_officer`.
 */
export const signSchema = z.object({
  signatureUrl: z.string().min(1).max(500),
  delegationId: z.string().uuid().optional(),
});

/** Co-maker (co-borrower / guarantor) intake. */
export const coMakerSchema = z.object({
  fullName: z.string().min(1).max(200),
  role: z.enum(["CO_BORROWER", "GUARANTOR", "CO_MAKER"]).optional(),
  relationship: z.string().max(80).optional(),
  phone: z.string().min(1).max(40),
  email: z.string().email().optional(),
  address: z.string().max(500).optional(),
  governmentIdType: z
    .enum(["PASSPORT", "DRIVERS_LICENSE", "NATIONAL_ID", "SSS", "TIN", "OTHER"])
    .optional(),
  governmentIdNumber: z.string().max(60).optional(),
  monthlyIncome: z.number().nonnegative().optional(),
  signedAgreementUrl: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
});

/**
 * Quote — preview schedule + fees for a candidate loan without
 * persisting. `productCode` selects the interest method + payment
 * frequency + fees; absent it defaults to declining-monthly no-fee.
 */
export const quoteSchema = z.object({
  principal: z.number().positive(),
  termMonths: z.number().int().positive(),
  annualInterestRate: z.number().min(0).max(1),
  productCode: z.string().optional(),
});

/**
 * Selfie-match — posted by the face-match worker after comparing the
 * apply-time selfie to the ID front. `score` is similarity in [0..1];
 * `distance` is the L2 embedding distance in [0..2]; `passed` reflects
 * the worker's threshold decision; `model` is the model identifier
 * (e.g. "face-api/ssd_mobilenetv1") for the audit trail.
 */
export const selfieMatchSchema = z.object({
  score: z.number().min(0).max(1),
  distance: z.number().min(0).max(2),
  passed: z.boolean(),
  model: z.string().min(1).max(80),
});

/**
 * Loan draft — apply-wizard saves progress between steps so the
 * officer can pause and resume. `formState` is owned by the wizard
 * and accepted as any JSON shape; final-submit validation runs
 * against `applySchema` separately.
 */
export const draftCreateSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  productCode: z.string().min(1).max(40).optional().nullable(),
  lastStep: z.number().int().min(0).max(20).optional(),
  formState: z.unknown(),
});

export const draftUpdateSchema = draftCreateSchema.partial();

export type SelfieMatchInput = z.infer<typeof selfieMatchSchema>;
export type DraftCreateInput = z.infer<typeof draftCreateSchema>;
export type DraftUpdateInput = z.infer<typeof draftUpdateSchema>;

// Inferred TypeScript types for service / test consumers.
export type ApplyInput = z.infer<typeof applySchema>;
export type DecideInput = z.infer<typeof decideSchema>;
export type PaymentInput = z.infer<typeof paymentSchema>;
export type BulkPaymentInput = z.infer<typeof bulkPaymentSchema>;
export type CloseEarlyInput = z.infer<typeof closeEarlySchema>;
export type RestructureInput = z.infer<typeof restructureSchema>;
export type WaivePenaltyInput = z.infer<typeof waivePenaltySchema>;
export type WriteOffInput = z.infer<typeof writeOffSchema>;
export type SignInput = z.infer<typeof signSchema>;
export type CoMakerInput = z.infer<typeof coMakerSchema>;
export type QuoteInput = z.infer<typeof quoteSchema>;
