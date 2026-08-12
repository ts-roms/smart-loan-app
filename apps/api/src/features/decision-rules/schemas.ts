import { z } from "zod";

/**
 * Decision-rule schemas. The rules engine evaluates them at
 * /loans/decide time — each rule is a set of conditions (AND-joined)
 * + an action (AUTO_APPROVE / AUTO_REJECT / MANUAL_REVIEW). Rules are
 * tried in `priority` order; first match wins.
 */

export const conditionSchema = z.object({
  field: z.string().min(1).max(40),
  op: z.enum(["=", "!=", "<", "<=", ">", ">=", "in", "not_in"]),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
});
export type ConditionInput = z.infer<typeof conditionSchema>;

export const createRuleSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  priority: z.number().int().min(0).max(99_999).optional(),
  conditions: z.array(conditionSchema).min(1).max(20),
  action: z.enum(["AUTO_APPROVE", "AUTO_REJECT", "MANUAL_REVIEW"]),
  reason: z.string().max(500).optional(),
  active: z.boolean().optional(),
});
export type CreateRuleInput = z.infer<typeof createRuleSchema>;

/**
 * Patch — every field optional. Zod's `.partial()` on the create
 * shape would also work but explicit is friendlier to read.
 *
 * `changeNote` rides along rather than sitting in the rule: it describes
 * the EDIT, not the rule, and belongs in the version row. Optional on
 * purpose — mandating it produces a hundred notes reading "update",
 * which is worse than a blank, because a blank does not pretend to be
 * an explanation.
 */
export const updateRuleSchema = createRuleSchema.partial().extend({
  changeNote: z.string().max(500).optional(),
});
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

/** Why a rule is being withdrawn. Same reasoning as `changeNote`. */
export const retireRuleSchema = z.object({
  changeNote: z.string().max(500).optional(),
});
export type RetireRuleInput = z.infer<typeof retireRuleSchema>;

/**
 * `?at=` for the historical rule set. Defaults to now, which makes
 * `/decision-rules/as-of` with no argument a plain listing — useful for
 * confirming the endpoint agrees with the live catalog.
 */
export const asOfQuerySchema = z.object({
  at: z.coerce.date().optional(),
});
export type AsOfQuery = z.infer<typeof asOfQuerySchema>;

/**
 * Response shapes, for the OpenAPI spec.
 *
 * zod rather than hand-written JSON Schema so they are real parsers: a
 * test can assert an actual payload against one, which is the only
 * thing that stops a published schema from quietly becoming fiction.
 *
 * They describe what is CONTRACTUAL, not everything a row happens to
 * carry — see lib/openapi.ts on why undeclared fields pass through.
 */
export const ruleResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  priority: z.number().int(),
  conditions: z.array(conditionSchema),
  action: z.enum(["AUTO_APPROVE", "AUTO_REJECT", "MANUAL_REVIEW"]),
  reason: z.string().nullable(),
  active: z.boolean(),
  /** Bumped only by edits that change an OUTCOME. */
  version: z.number().int(),
  effectiveFrom: z.string().datetime(),
  /** Set when the rule was withdrawn; retired rules never list. */
  retiredAt: z.string().datetime().nullable(),
});

export const ruleListResponseSchema = z.array(ruleResponseSchema);

/**
 * One frozen revision. `effectiveTo` is null on the current version and
 * EQUAL to `effectiveFrom` on a RETIRE row, which is a zero-width window
 * on purpose: that row records a withdrawal, not a period in force.
 */
export const ruleVersionResponseSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  version: z.number().int(),
  ruleName: z.string(),
  description: z.string().nullable(),
  priority: z.number().int(),
  conditions: z.array(conditionSchema),
  action: z.enum(["AUTO_APPROVE", "AUTO_REJECT", "MANUAL_REVIEW"]),
  reason: z.string().nullable(),
  active: z.boolean(),
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable(),
  changeType: z.enum(["CREATE", "UPDATE", "RETIRE"]),
  changeNote: z.string().nullable(),
  changedById: z.string().nullable(),
});

export const ruleVersionListResponseSchema = z.array(ruleVersionResponseSchema);

export const seedResponseSchema = z.object({
  created: z.number().int(),
  existing: z.number().int(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });
