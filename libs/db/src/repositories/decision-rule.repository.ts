/**
 * Decision-rule catalog. Rules are evaluated by @loan/decisioning;
 * persistence + admin CRUD live here.
 */
import {
  DEFAULT_RULES,
  type DecisionRule as RuleData,
  type DecisioningCondition,
  type RuleAction,
} from '@loan/decisioning';
import type { DecisionRule, PrismaClient } from '@prisma/client';

export interface DecisionRuleInput {
  name: string;
  description?: string;
  priority?: number;
  conditions: DecisioningCondition[];
  action: RuleAction;
  reason?: string;
  active?: boolean;
}

export class DecisionRuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<DecisionRule[]> {
    return this.prisma.decisionRule.findMany({ orderBy: { priority: 'asc' } });
  }

  listActive(): Promise<DecisionRule[]> {
    return this.prisma.decisionRule.findMany({
      where: { active: true },
      orderBy: { priority: 'asc' },
    });
  }

  findByName(name: string): Promise<DecisionRule | null> {
    return this.prisma.decisionRule.findUnique({ where: { name } });
  }

  create(input: DecisionRuleInput): Promise<DecisionRule> {
    return this.prisma.decisionRule.create({
      data: {
        name: input.name,
        description: input.description,
        priority: input.priority ?? 500,
        conditions: input.conditions as never,
        action: input.action,
        reason: input.reason,
        active: input.active ?? true,
      },
    });
  }

  update(id: string, input: Partial<DecisionRuleInput>): Promise<DecisionRule> {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.conditions !== undefined) data.conditions = input.conditions;
    if (input.action !== undefined) data.action = input.action;
    if (input.reason !== undefined) data.reason = input.reason;
    if (input.active !== undefined) data.active = input.active;
    return this.prisma.decisionRule.update({ where: { id }, data: data as never });
  }

  delete(id: string): Promise<DecisionRule> {
    return this.prisma.decisionRule.delete({ where: { id } });
  }

  /** Idempotent seed of the shipped defaults. */
  async seedDefaults(): Promise<{ created: number; existing: number }> {
    let created = 0;
    let existing = 0;
    for (const r of DEFAULT_RULES) {
      const found = await this.findByName(r.name);
      if (found) {
        existing += 1;
        continue;
      }
      await this.create(r);
      created += 1;
    }
    return { created, existing };
  }

  /** Convert DB rows into the shape `evaluateRules` expects. */
  toEvaluable(rows: DecisionRule[]): RuleData[] {
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      conditions: r.conditions as unknown as DecisioningCondition[],
      action: r.action as RuleAction,
      reason: r.reason ?? undefined,
      active: r.active,
    }));
  }
}
