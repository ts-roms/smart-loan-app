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
