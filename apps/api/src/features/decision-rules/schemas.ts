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
 */
export const updateRuleSchema = createRuleSchema.partial();
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
