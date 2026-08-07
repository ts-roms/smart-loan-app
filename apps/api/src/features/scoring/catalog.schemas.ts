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
   */
  weight: z.number().positive().max(1000),
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
