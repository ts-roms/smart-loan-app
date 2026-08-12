import { z } from "zod";

/**
 * Survey submission shape. `answers` is a free-form key→value map
 * keyed by question id — the questionnaire structure is owned by
 * `@loan/credit-scoring` and the renderer pulls it from
 * `GET /scoring/survey/questions`.
 */
export const submitSurveySchema = z.object({
  customerId: z.string().uuid(),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type SubmitSurveyInput = z.infer<typeof submitSurveySchema>;

/** `?score=720` on the tier convenience endpoint. */
export const tierQuerySchema = z.object({
  score: z.coerce.number().finite(),
});
export type TierQuery = z.infer<typeof tierQuerySchema>;

export const customerIdParamSchema = z.object({
  customerId: z.string().uuid(),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod rather than hand-written JSON Schema so they are real parsers: a
 * test can assert an actual payload against one, which is the only thing
 * that stops a published schema from quietly becoming fiction. They
 * describe what is CONTRACTUAL — undeclared fields pass through
 * untouched, see lib/openapi.ts.
 *
 * A field declared without `.optional()` must be present on EVERY
 * payload the route can return: Fastify's serialiser throws on a missing
 * required property, turning a 200 into a 500.
 */

const tierSchema = z.enum(["A", "B", "C", "D", "F"]);
const bucketSchema = z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR"]);

/**
 * A questionnaire item as the renderer consumes it.
 *
 * Flattened rather than written as a zod union of the three kinds. The
 * union would emit `anyOf`, and `anyOf` has no `type`, so the helper's
 * permissive pass — which recurses on objects and arrays — would never
 * reach the branches and Fastify would strip every undeclared field
 * inside them. One object with the kind-specific fields marked optional
 * says the same thing and survives the serialiser.
 */
export const surveyQuestionResponseSchema = z.object({
  kind: z.enum(["choice", "number", "boolean"]),
  /** The question KEY. Answers are submitted under it. */
  id: z.string(),
  label: z.string(),
  /** Absent, not null, when the question carries no hint. */
  help: z.string().optional(),
  /** Which factor's points this question competes for. */
  factorId: z.string(),
  /** kind=choice. Each option's weight is its share of the factor, 0..1. */
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        weight: z.number(),
      }),
    )
    .optional(),
  /** kind=number. The range mapped linearly onto weight 0..1. */
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** kind=number. True means a HIGHER answer scores lower. */
  inverted: z.boolean().optional(),
  /** kind=boolean. Weight contributed by `true`; `false` contributes 0. */
  weightWhenTrue: z.number().optional(),
});

export const surveyQuestionListResponseSchema = z.array(
  surveyQuestionResponseSchema,
);

/**
 * Per-factor explanation. This is what makes a score answerable to the
 * borrower it was computed for, so it is contractual in full.
 */
const breakdownResponseSchema = z.array(
  z.object({
    factorId: z.string(),
    label: z.string(),
    /** The factor's ceiling after normalisation against the fixed total. */
    maxPoints: z.number(),
    /** What the answer earned, 0..1. */
    weight: z.number(),
    /** round(maxPoints * weight). */
    points: z.number(),
    /** Plain-language reason, e.g. "Regular employee (1+ year)". */
    source: z.string(),
  }),
);

/** What POST /survey/submit answers with: the computed score, not a row. */
export const submitSurveyResponseSchema = z.object({
  /** 300..850. */
  score: z.number().int(),
  tier: tierSchema,
  bucket: bucketSchema,
  /** Sum of the breakdown's points, before scaling. */
  rawScore: z.number(),
  /** The FIXED ceiling raw scores are scaled against — never the sum of
   *  whatever the catalog currently holds, which is what keeps a 720
   *  meaning the same thing across catalog edits. */
  maxRaw: z.number(),
  breakdown: breakdownResponseSchema,
  /** The SurveyResponse row this score was persisted against. */
  surveyId: z.string().uuid(),
});

/** The persisted latest score for a customer. */
export const creditScoreResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  score: z.number().int(),
  tier: tierSchema,
  breakdown: breakdownResponseSchema,
  /** Null when the score did not come from a questionnaire. */
  sourceSurveyId: z.string().uuid().nullable(),
  /**
   * Which scorecard produced it. Null on scores computed before the
   * catalog was versioned — honest rather than invented: the catalog of
   * the day was never recorded.
   */
  catalogVersion: z.number().int().nullable(),
  computedAt: z.string().datetime(),
});

/** Pure lookup — no row is read or written. */
export const tierResponseSchema = z.object({
  score: z.number(),
  /** Internal A–F band, used by per-tier pricing and LTV configs. */
  tier: tierSchema,
  /** Bureau-style 4-bucket label, for customer-facing surfaces. */
  bucket: bucketSchema,
});
