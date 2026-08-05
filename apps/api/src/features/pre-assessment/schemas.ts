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
