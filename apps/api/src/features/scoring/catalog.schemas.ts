import { z } from "zod";

/**
 * Scoring-catalog wire schemas.
 *
 * Keys are lowercase slugs and immutable after creation — stored score
 * breakdowns reference factor keys, and SurveyResponse.answers is keyed
 * by question key, so a rename orphans history. The update schemas
 * simply omit `key` rather than validating it, which makes the rule
 * unexpressible on the wire instead of merely rejected.
 */

const slug = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9_]+$/, "must be a lowercase slug");

export const factorCreateSchema = z.object({
  key: slug,
  label: z.string().min(1).max(120),
  /**
   * Relative share, not points. Positive only — a zero-weight factor
   * would consume a slot in the catalog while contributing nothing,
   * which is what `active: false` is for.
   *
   * The bound is a `.refine`, not `.positive()`, and that is not a
   * style choice. This schema is now published, and the helper renders
   * zod in the OpenAPI 3.0 dialect, where an exclusive bound is
   * `minimum: 0` + `exclusiveMinimum: true`. AJV — which Fastify
   * compiles request schemas with — only accepts the NUMERIC form, and
   * rejects the boolean one while building the route: the whole server
   * fails to start with "exclusiveMinimum must be number". A refinement
   * is invisible to JSON Schema, so the published shape stays valid and
   * this parse still rejects zero and negatives exactly as before.
   */
  weight: z
    .number()
    .max(1000)
    .refine((w) => w > 0, { message: "Number must be greater than 0" }),
  computed: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});
export type FactorCreateInput = z.infer<typeof factorCreateSchema>;

export const factorUpdateSchema = factorCreateSchema
  .omit({ key: true })
  .partial();
export type FactorUpdateInput = z.infer<typeof factorUpdateSchema>;

/**
 * Per-kind config. A discriminated union rather than one loose object:
 * each kind's fields are meaningless to the others, and a CHOICE row
 * carrying `min`/`max` is a bug waiting to score someone wrongly.
 */
const choiceConfig = z.object({
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(160),
        value: z.string().min(1).max(60),
        /** 0..1 — the share of the factor's points this answer earns. */
        weight: z.number().min(0).max(1),
      }),
    )
    .min(2)
    .max(12)
    // Answers are stored by VALUE. Two options sharing one make the
    // second unselectable — every stored answer resolves to the first.
    .refine((opts) => new Set(opts.map((o) => o.value)).size === opts.length, {
      message: "option values must be distinct",
    }),
});

const numberConfig = z
  .object({
    min: z.number(),
    max: z.number(),
    step: z.number().positive().optional(),
    /** Higher answers score LOWER (existing debt, dependents). */
    inverted: z.boolean().optional(),
  })
  .refine((c) => c.max > c.min, { message: "max must exceed min" });

const booleanConfig = z.object({
  weightWhenTrue: z.number().min(0).max(1),
});

const questionBase = {
  kind: z.enum(["CHOICE", "NUMBER", "BOOLEAN"]),
  label: z.string().min(1).max(300),
  help: z.string().max(300).nullable().optional(),
  category: z.string().max(60).nullable().optional(),
  order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  factorId: z.string().uuid(),
};

/**
 * Cross-validates config against kind. Zod can't express "config shape
 * depends on a sibling field" in one object schema, so this runs the
 * matching sub-schema in a superRefine and reports failures against the
 * `config` path, where the form can show them.
 *
 * A standalone refinement rather than a generic wrapper: chaining
 * `.superRefine(checkConfig)` onto each concrete schema keeps zod's
 * inference intact, where a `<T extends ZodTypeAny>` wrapper resolves
 * against the constraint and flattens every inferred type to `any`.
 */
const configSchemaFor = (kind: string) =>
  kind === "CHOICE"
    ? choiceConfig
    : kind === "NUMBER"
      ? numberConfig
      : booleanConfig;

/**
 * Validate a kind/config pair OUTSIDE a schema — for the update path,
 * where the effective pair is half request and half stored row, so the
 * request schema alone can never see both. Returns zod-shaped issues
 * anchored at `config`, or null when the pair is valid.
 */
export function validateKindConfig(
  kind: string,
  config: unknown,
): Array<{ path: (string | number)[]; message: string }> | null {
  const result = configSchemaFor(kind).safeParse(config);
  if (result.success) return null;
  return result.error.issues.map((issue) => ({
    path: ["config", ...issue.path],
    message: issue.message,
  }));
}

const checkConfig = (
  val: { kind?: string; config?: unknown },
  ctx: z.RefinementCtx,
): void => {
  if (!val.kind || val.config === undefined) return;
  const result = configSchemaFor(val.kind).safeParse(val.config);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config", ...issue.path],
      message: issue.message,
    });
  }
};

export const questionCreateSchema = z
  .object({ key: slug, ...questionBase, config: z.unknown() })
  .superRefine(checkConfig)
  // `z.unknown()` accepts a missing key, and checkConfig skips a config
  // it wasn't given — so without this a question could be created with
  // no config at all and then silently score nothing.
  .refine((v) => v.config !== undefined, {
    message: "config is required",
    path: ["config"],
  });
export type QuestionCreateInput = z.infer<typeof questionCreateSchema>;

export const questionUpdateSchema = z
  .object({
    kind: questionBase.kind.optional(),
    label: questionBase.label.optional(),
    help: questionBase.help,
    category: questionBase.category,
    order: questionBase.order,
    active: questionBase.active,
    factorId: questionBase.factorId.optional(),
    config: z.unknown().optional(),
  })
  .superRefine(checkConfig);
export type QuestionUpdateInput = z.infer<typeof questionUpdateSchema>;

/** Body of the reorder endpoints — ids in their new order. */
export const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderInput = z.infer<typeof reorderSchema>;

export const catalogIdParamSchema = z.object({ id: z.string().uuid() });

/**
 * `:version` as it arrives — a path segment, i.e. a string.
 *
 * Not coerced to a number: Fastify's ajv would answer a non-integer with
 * its own 400, replacing the controller's
 * `{ error: "ValidationError", message: "Version must be a positive
 * integer." }` that callers already receive.
 */
export const versionParamSchema = z.object({ version: z.string() });

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * See lib/openapi.ts: these say "you can rely on these fields", not
 * "there is nothing else". Anything undeclared passes through the
 * serialiser untouched; anything declared WITHOUT `.optional()` must be
 * present on every payload the route can return, because Fastify's
 * serialiser throws on a missing required property.
 */

const questionKindSchema = z.enum(["CHOICE", "NUMBER", "BOOLEAN"]);

/**
 * A stored question row.
 *
 * `config` is declared only as an object. Its shape depends on `kind` —
 * options for CHOICE, min/max for NUMBER, weightWhenTrue for BOOLEAN —
 * and a zod union would emit `anyOf`, which the helper's permissive pass
 * cannot reach (it recurses on objects and arrays, and `anyOf` is
 * neither), so every field inside it would be stripped on the way out.
 */
export const questionRowResponseSchema = z.object({
  id: z.string().uuid(),
  /** Immutable. `SurveyResponse.answers` is keyed by it. */
  key: z.string(),
  kind: questionKindSchema,
  label: z.string(),
  help: z.string().nullable(),
  /** Free-text grouping heading for the form. */
  category: z.string().nullable(),
  order: z.number().int(),
  /** Inactive questions are not asked and score nothing. */
  active: z.boolean(),
  config: z.record(z.unknown()),
});

/** A stored factor row, as the write endpoints return it. */
export const factorRowResponseSchema = z.object({
  id: z.string().uuid(),
  /** Immutable. Stored score breakdowns reference it. */
  key: z.string(),
  label: z.string(),
  /** Relative share, not points. Only ratios between factors matter. */
  weight: z.number(),
  /** Derived from loan history rather than an answer; no questions. */
  computed: z.boolean(),
  order: z.number().int(),
  active: z.boolean(),
});

/**
 * The builder's view: factors with their questions, and each factor's
 * weight RESOLVED into the points it is actually worth.
 *
 * Resolution is served rather than left to the client on purpose —
 * deriving it in the browser would be a second implementation of the
 * apportionment, and that is exactly how the builder and the scorer come
 * to disagree about what a factor is worth.
 */
export const catalogResponseSchema = z.object({
  /** The fixed ceiling weights normalise onto. Not configurable. */
  totalPoints: z.number(),
  factors: z.array(
    factorRowResponseSchema.extend({
      /** Null when the factor is inactive — it contributes nothing. */
      maxPoints: z.number().nullable(),
      questions: z.array(questionRowResponseSchema),
    }),
  ),
});

const changeTypeSchema = z.enum([
  "BASELINE",
  "FACTOR_ADDED",
  "FACTOR_CHANGED",
  "FACTOR_REMOVED",
  "QUESTION_ADDED",
  "QUESTION_CHANGED",
  "QUESTION_REMOVED",
  "REORDERED",
]);

/**
 * One scorecard revision, WITHOUT its snapshot.
 *
 * The whole catalog is one version, not one per factor: points normalise
 * against a fixed total, so raising one factor's weight lowers every
 * other factor's points and there is no edit that touches one factor.
 */
export const catalogVersionSummaryResponseSchema = z.object({
  id: z.string().uuid(),
  /** 1-based and dense. Stamped onto CreditScore and SurveyResponse. */
  version: z.number().int(),
  factorCount: z.number().int(),
  questionCount: z.number().int(),
  effectiveFrom: z.string().datetime(),
  /** Null on the version in force now. */
  effectiveTo: z.string().datetime().nullable(),
  changeType: changeTypeSchema,
  /** Generated one-liner, e.g. "weight changed on 'income'". */
  changeSummary: z.string().nullable(),
  changeNote: z.string().nullable(),
  /** Not a foreign key — staff leave, the history outlives them. */
  changedById: z.string().nullable(),
});

export const catalogHistoryResponseSchema = z.array(
  catalogVersionSummaryResponseSchema,
);

/**
 * One revision WITH its snapshot — the replayable payload.
 *
 * `snapshot` is exactly the shape `computeCreditScore` takes, so
 * rescoring a borrower under the scorecard that scored them is a
 * function call rather than a reconstruction. Its interior is left
 * undeclared for that reason: it is a verbatim record, and a schema
 * summarising it would be a second description of a frozen payload.
 */
export const catalogVersionResponseSchema =
  catalogVersionSummaryResponseSchema.extend({
    snapshot: z.record(z.unknown()),
  });
