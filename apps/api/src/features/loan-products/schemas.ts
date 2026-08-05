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
