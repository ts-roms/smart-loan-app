import { z } from "zod";

/**
 * Pre-assessment wire schemas.
 *
 * The officer-facing body accepts two mutually-understood shapes in one
 * object rather than a discriminated union, because the officer UI is a
 * single form: pick a customer from the typeahead, OR fill in the walk-in
 * fields. A union would make the client encode which mode it's in, which
 * is state the server can infer from `customerId` being present.
 */

const terms = {
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  /** Annual rate as a decimal: 0.24 = 24% APR. Matches /loans/apply. */
  annualInterestRate: z.number().min(0).max(1),
};

export const preAssessmentSchema = z
  .object({
    ...terms,
    /** Assess someone already on file. Wins over the prospect fields. */
    customerId: z.string().uuid().optional(),

    // Walk-in prospect. Name is required in this mode so the saved row is
    // identifiable afterwards — an anonymous assessment is a row nobody
    // can act on.
    prospectName: z.string().min(1).max(160).optional(),
    prospectPhone: z.string().min(7).max(40).optional(),
    prospectEmail: z.string().email().max(120).optional(),
    /**
     * Required without a customerId — with no Customer row there is
     * nothing to read an income off. Zero is allowed (an applicant may
     * genuinely declare none); the rules decide what to do about it.
     */
    monthlyIncome: z.number().min(0).max(50_000_000).optional(),
    /**
     * Required without a customerId. Lower bound is 16 rather than 18:
     * age minimums are underwriting policy and belong in a decision rule,
     * not in request validation, so the schema only rejects values that
     * can't be a real applicant's age.
     */
    applicantAge: z.number().int().min(16).max(120).optional(),
  })
  .refine(
    (v) =>
      Boolean(v.customerId) ||
      (Boolean(v.prospectName) &&
        v.monthlyIncome !== undefined &&
        v.applicantAge !== undefined),
    {
      message:
        "Provide customerId, or prospectName + monthlyIncome + applicantAge for a walk-in prospect.",
    },
  );
export type PreAssessmentInput = z.infer<typeof preAssessmentSchema>;

/**
 * Borrower-portal body. No subject fields at all — the customer is the
 * caller, resolved from the JWT subject, and a client-supplied id is never
 * trusted here.
 */
export const portalPreAssessmentSchema = z.object(terms);
export type PortalPreAssessmentInput = z.infer<
  typeof portalPreAssessmentSchema
>;

/** Staff list filters. All optional; the default is "50 most recent". */
export const preAssessmentQuerySchema = z.object({
  customerId: z.string().uuid().optional(),
  source: z.enum(["PORTAL", "OFFICER"]).optional(),
  verdict: z.enum(["APPROVE", "REVIEW", "REJECT"]).optional(),
  /** Matches the number ("PA-2026-000123") or a prospect's name. */
  q: z.string().max(120).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});
export type PreAssessmentQuery = z.infer<typeof preAssessmentQuerySchema>;

/* ─── Responses ────────────────────────────────────────────────────────*/

/** `:id` on the detail route — a uuid OR a "PA-2026-000123" number. */
export const preAssessmentIdParamSchema = z.object({
  /** Not `.uuid()`: `findByIdOrNumber` accepts the human number too. */
  id: z.string().min(1),
});

/**
 * One pre-assessment, as the service hands it out.
 *
 * **Money is a NUMBER here, not a decimal string** — the usual rule for
 * this codebase inverted, and deliberately so. `principal`,
 * `annualInterestRate` and `monthlyIncome` are `Decimal` columns, but
 * `toWire` runs every one of them through `Number(...)` before the
 * payload leaves the service, so no Decimal ever reaches the
 * serialiser. Declaring them as strings would be exactly as wrong as
 * declaring the ECL history's stored Decimals as numbers.
 *
 * `basis` is derived rather than stored: FULL when the subject is a
 * customer on file (score, AML and KYC all readable), INDICATIVE for a
 * walk-in prospect where there is nothing to read.
 */
const anomalyFlagSchema = z.object({
  code: z.enum([
    "PRINCIPAL_OUTLIER",
    "TERM_OUTLIER",
    "RATE_OUTLIER",
    "APPLICANT_VELOCITY",
    "PRINCIPAL_TO_INCOME",
    "INSUFFICIENT_BASELINE",
  ]),
  severity: z.enum(["low", "medium", "high"]),
  message: z.string(),
  zScore: z.number().nullable(),
  observed: z.number().nullable(),
  baseline: z.number().nullable(),
});

export const preAssessmentResponseSchema = z.object({
  id: z.string().uuid(),
  /** "PA-2026-000123". */
  number: z.string(),
  source: z.enum(["PORTAL", "OFFICER"]),
  customerId: z.string().uuid().nullable(),
  prospectName: z.string().nullable(),
  prospectPhone: z.string().nullable(),
  prospectEmail: z.string().nullable(),
  productCode: z.string(),
  /** Number, not a decimal string — see the note above. */
  principal: z.number(),
  termMonths: z.number().int(),
  /** Decimal fraction: 0.24 = 24% APR. */
  annualInterestRate: z.number(),
  monthlyIncome: z.number(),
  applicantAge: z.number().int(),
  verdict: z.enum(["APPROVE", "REVIEW", "REJECT"]),
  reason: z.string(),
  matchedRuleId: z.string().nullable(),
  matchedRuleName: z.string().nullable(),
  matchedRuleVersion: z.number().int().nullable(),
  /** FULL for a customer on file; INDICATIVE for a walk-in prospect. */
  basis: z.enum(["FULL", "INDICATIVE"]),
  /** Null for a prospect — there is no record to check AML or KYC against. */
  gates: z
    .object({
      amlMatch: z.boolean(),
      kycComplete: z.boolean(),
      missingKycDocs: z.array(z.string()),
      rejectedKycDocs: z.array(z.string()),
    })
    .nullable(),
  /** Always an array, empty rather than absent. */
  anomalies: z.array(anomalyFlagSchema),
  context: z.object({
    principal: z.number(),
    termMonths: z.number().int(),
    annualInterestRate: z.number(),
    productCode: z.string(),
    creditScore: z.number().nullable(),
    tier: z.string().nullable(),
    monthlyIncome: z.number(),
    existingActiveLoans: z.number().int(),
  }),
  /** Set once this assessment became a real application. */
  loanId: z.string().uuid().nullable(),
  convertedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  createdById: z.string().uuid().nullable(),
  /**
   * Always present as a key, null for a prospect. Also null on the POST
   * response specifically: the create path does no relation include, so
   * the customer is only populated by the two read routes.
   */
  customer: z
    .object({
      id: z.string().uuid(),
      number: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    })
    .nullable(),
});

/** The list route — a bare array, newest first, no paging envelope. */
export const preAssessmentListResponseSchema = z.array(
  preAssessmentResponseSchema,
);
