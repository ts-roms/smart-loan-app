import { z } from "zod";

const DOC_TYPES = [
  "ID_FRONT",
  "ID_BACK",
  "PROOF_OF_INCOME",
  "PROOF_OF_ADDRESS",
  "SELFIE",
  "VEHICLE_OR",
  "VEHICLE_CR",
  "PROPERTY_TITLE",
  "TAX_DECLARATION",
] as const;

const TIER_VALUES = ["A", "B", "C", "D", "F"] as const;

const tierMap = z
  .record(z.enum(TIER_VALUES), z.number().min(0).max(1).nullable())
  .nullable()
  .optional();

/**
 * One declaration question. Ids are slugs the builder UI generates;
 * SELECT must offer at least two options — one option is a statement,
 * not a question.
 */
const kycQuestionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9_]+$/, "id must be a lowercase slug"),
    label: z.string().min(1).max(300),
    type: z.enum(["TEXT", "YES_NO", "NUMBER", "SELECT"]),
    options: z.array(z.string().min(1).max(120)).max(20).optional(),
    required: z.boolean(),
    hint: z.string().max(300).optional(),
    category: z.string().max(60).optional(),
  })
  .refine((q) => q.type !== "SELECT" || (q.options?.length ?? 0) >= 2, {
    message: "SELECT questions need at least two options",
  });

const kycQuestionsSchema = z
  .array(kycQuestionSchema)
  .max(50)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, {
    message: "Question ids must be unique",
  });

const baseSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  collateralKind: z.enum(["NONE", "VEHICLE", "PROPERTY"]).optional(),
  requiredKycDocs: z.array(z.enum(DOC_TYPES)).optional(),
  /** Admin-built declaration questionnaire. Empty array clears it. */
  kycQuestions: kycQuestionsSchema.optional(),

  minPrincipal: z.number().nonnegative(),
  maxPrincipal: z.number().positive(),
  minTermMonths: z.number().int().positive(),
  maxTermMonths: z.number().int().positive(),
  defaultRate: z.number().min(0).max(1),
  minRate: z.number().min(0).max(1),
  maxRate: z.number().min(0).max(1),
  maxLoanToValue: z.number().min(0).max(1).nullable().optional(),

  processingFeeRate: z.number().min(0).max(1).optional(),
  processingFeeFlat: z.number().min(0).optional(),
  documentaryStampRate: z.number().min(0).max(1).optional(),
  lateFeeDailyRate: z.number().min(0).max(1).optional(),
  lateFeeCapFraction: z.number().min(0).max(1).optional(),
  lateFeeGraceDays: z.number().int().min(0).max(365).optional(),
  preTerminationFeeRate: z.number().min(0).max(1).optional(),

  interestMethod: z.enum(["DECLINING", "FLAT"]).optional(),
  paymentFrequency: z.enum(["MONTHLY", "BIWEEKLY", "WEEKLY"]).optional(),

  rateByTier: tierMap,
  ltvByTier: z
    .record(z.enum(TIER_VALUES), z.number().min(0).max(1))
    .nullable()
    .optional(),

  active: z.boolean().optional(),
});

export const createSchema = baseSchema.extend({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, {
    message: "Code must be UPPER_SNAKE_CASE",
  }),
});

export const updateSchema = baseSchema.partial();

/**
 * Path param for every /:code route.
 *
 * Unconstrained, unlike `createSchema.code`. Creating a product with a
 * lowercase code should be refused; LOOKING one up with a lowercase
 * code should answer 404, because that is the truth — no such product.
 */
export const productCodeParamSchema = z.object({ code: z.string() });

// ─── Response schemas ─────────────────────────────────────────────────

/**
 * A loan product as stored.
 *
 * EVERY numeric parameter here is a `Decimal` column and therefore a
 * STRING on the wire — `"0.1800"`, not `0.18`. The create/update bodies
 * take numbers, so the round trip is deliberately asymmetric and this
 * is the half integrators get wrong. Doing arithmetic on the response
 * without a parse silently concatenates.
 */
export const loanProductResponseSchema = z.object({
  id: z.string().uuid(),
  /** Stable identifier; what LoanApplication.productCode references. */
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  collateralKind: z.enum(["NONE", "VEHICLE", "PROPERTY"]),
  /** Documents required ON TOP OF the base KYC pack. */
  requiredKycDocs: z.array(z.string()),
  /**
   * The admin-built declaration questionnaire, or null for a product
   * that asks nothing. A free-form JSON array — see @loan/kyc's
   * KycQuestion for the element shape.
   */
  kycQuestions: z.unknown().nullable(),

  minPrincipal: z.string(),
  maxPrincipal: z.string(),
  minTermMonths: z.number().int(),
  maxTermMonths: z.number().int(),
  /** Annual rate as a decimal string: "0.1800" is 18%/year. */
  defaultRate: z.string(),
  minRate: z.string(),
  maxRate: z.string(),
  /** Null on unsecured products. `ltvByTier` overrides it when set. */
  maxLoanToValue: z.string().nullable(),

  processingFeeRate: z.string(),
  processingFeeFlat: z.string(),
  documentaryStampRate: z.string(),
  lateFeeDailyRate: z.string(),
  lateFeeCapFraction: z.string(),
  lateFeeGraceDays: z.number().int(),
  preTerminationFeeRate: z.string(),

  interestMethod: z.enum(["DECLINING", "FLAT"]),
  paymentFrequency: z.enum(["MONTHLY", "BIWEEKLY", "WEEKLY"]),

  /** Credit tier → rate. A tier mapped to null is rejected outright. */
  rateByTier: z.unknown().nullable(),
  /** Credit tier → max LTV. Overrides `maxLoanToValue`. */
  ltvByTier: z.unknown().nullable(),

  active: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),

  /** IFRS 9 provisioning inputs. Decimal strings, same as the rates. */
  eclPd12m: z.string(),
  eclPdLifetime: z.string(),
  eclLgd: z.string(),

  /** Lease-to-own: title stays with the company until the residual is paid. */
  isLease: z.boolean(),
  residualValueFraction: z.string().nullable(),
  employeeOnly: z.boolean(),
  missedPaymentPullOutCount: z.number().int(),
  maintenanceReminderMonths: z.number().int(),

  /** Default agent commission as a fraction of principal. */
  agentCommissionRate: z.string(),
});

export const loanProductListResponseSchema = z.array(loanProductResponseSchema);

/** POST /loan-products/seed — how many defaults were inserted vs found. */
export const seedResponseSchema = z.object({
  created: z.number().int(),
  existing: z.number().int(),
});

/**
 * One step of a product's approval chain.
 *
 * `order` in the response is always contiguous 1..N: `saveSteps`
 * renumbers whatever the caller sent, so a PUT with orders 10/20/30
 * comes back as 1/2/3.
 */
export const approvalStepResponseSchema = z.object({
  id: z.string().uuid(),
  productCode: z.string(),
  order: z.number().int(),
  /** Frozen onto LoanApproval rows at submit, so history never drifts. */
  label: z.string(),
  /** Permission key the approver must hold, directly or by delegation. */
  requiredPermission: z.string(),
  optional: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const approvalChainResponseSchema = z.array(approvalStepResponseSchema);
