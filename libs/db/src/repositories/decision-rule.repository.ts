/**
 * Decision-rule catalog. Rules are evaluated by @loan/decisioning;
 * persistence + admin CRUD live here.
 *
 * Every rule is versioned. The reason is a question a lender has to be
 * able to answer and, before this, could not: *on what basis was this
 * loan approved in March?* Rules live in a table precisely so they can
 * be retuned, and retuning used to overwrite the only copy — so the
 * honest answer to that question was "on the basis of whatever the rule
 * says today", which is not an answer at all. Now each change closes the
 * standing version and opens the next, and a decision records which one
 * decided it.
 */
import {
  DEFAULT_RULES,
  type DecisionRule as RuleData,
  type DecisioningCondition,
  type RuleAction,
} from "@loan/decisioning";
import type {
  DecisionRule,
  DecisionRuleVersion,
  Prisma,
  PrismaClient,
} from "@prisma/client";

export interface DecisionRuleInput {
  name: string;
  description?: string;
  priority?: number;
  conditions: DecisioningCondition[];
  action: RuleAction;
  reason?: string;
  active?: boolean;
}

/** Who changed a rule and why. Both optional; neither is load-bearing. */
export interface RuleChangeMeta {
  changedById?: string;
  changeNote?: string;
}

/**
 * Fields whose value decides an outcome.
 *
 * Only these mint a version. Renaming a rule or rewording its
 * description changes what an operator reads, not what a borrower gets,
 * so it does not open a new version — if it did, the history would fill
 * with entries an auditor has to open and discard, and the ones that
 * matter would be harder to find rather than easier.
 *
 * `active` is here because switching a rule off changes every subsequent
 * decision it would have made.
 */
const DECISIVE = [
  "priority",
  "conditions",
  "action",
  "reason",
  "active",
] as const;

export class DecisionRuleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Live rules. Retired ones are excluded — see `retire`. */
  list(): Promise<DecisionRule[]> {
    return this.prisma.decisionRule.findMany({
      where: { retiredAt: null },
      orderBy: { priority: "asc" },
    });
  }

  listActive(): Promise<DecisionRule[]> {
    return this.prisma.decisionRule.findMany({
      where: { active: true, retiredAt: null },
      orderBy: { priority: "asc" },
    });
  }

  findByName(name: string): Promise<DecisionRule | null> {
    return this.prisma.decisionRule.findUnique({ where: { name } });
  }

  /** Full history for one rule, newest first. */
  historyFor(ruleId: string): Promise<DecisionRuleVersion[]> {
    return this.prisma.decisionRuleVersion.findMany({
      where: { ruleId },
      orderBy: { version: "desc" },
    });
  }

  /** One specific version — what a stamped decision points at. */
  findVersion(
    ruleId: string,
    version: number,
  ): Promise<DecisionRuleVersion | null> {
    return this.prisma.decisionRuleVersion.findUnique({
      where: { ruleId_version: { ruleId, version } },
    });
  }

  /**
   * The rule set as it stood at a moment in time.
   *
   * The half of the audit answer that a per-decision stamp cannot give:
   * a stamp says which rule fired, this says what else could have. "Why
   * did nothing stricter catch this?" is answerable only by knowing the
   * whole set, including the rules that were switched off that week.
   *
   * A version is in force at `at` when it had already taken effect and
   * had not yet been superseded — the half-open window
   * [effectiveFrom, effectiveTo).
   */
  async asOf(at: Date): Promise<DecisionRuleVersion[]> {
    return this.prisma.decisionRuleVersion.findMany({
      where: {
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { priority: "asc" },
    });
  }

  /** Create the rule and open version 1 in one transaction. */
  async create(
    input: DecisionRuleInput,
    meta: RuleChangeMeta = {},
  ): Promise<DecisionRule> {
    return this.prisma.$transaction(async (tx) => {
      const rule = await tx.decisionRule.create({
        data: {
          name: input.name,
          description: input.description,
          priority: input.priority ?? 500,
          conditions: input.conditions as never,
          action: input.action,
          reason: input.reason,
          active: input.active ?? true,
          version: 1,
        },
      });
      await tx.decisionRuleVersion.create({
        data: versionRow(rule, 1, "CREATE", rule.effectiveFrom, meta),
      });
      return rule;
    });
  }

  /**
   * Apply an edit. Mints a version only when something decisive changed.
   *
   * The two writes — close the standing version, open the next — are one
   * transaction, and the unique index on (ruleId, version) is what makes
   * two concurrent editors safe: both read version N, both try to write
   * N+1, and the loser's whole transaction rolls back rather than
   * leaving the rule with two open versions. It is the same shape as
   * every other claim in this codebase: the database refuses, rather
   * than the code checking first and hoping.
   */
  async update(
    id: string,
    input: Partial<DecisionRuleInput>,
    meta: RuleChangeMeta = {},
  ): Promise<DecisionRule> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.decisionRule.findUnique({ where: { id } });
      if (!current) throw new DecisionRuleNotFoundError(id);
      if (current.retiredAt) throw new DecisionRuleRetiredError(id);

      const data: Prisma.DecisionRuleUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.description !== undefined) data.description = input.description;
      if (input.priority !== undefined) data.priority = input.priority;
      if (input.conditions !== undefined)
        data.conditions = input.conditions as never;
      if (input.action !== undefined) data.action = input.action;
      if (input.reason !== undefined) data.reason = input.reason;
      if (input.active !== undefined) data.active = input.active;

      const merged = { ...current, ...(data as Partial<DecisionRule>) };
      if (!decisiveChange(current, merged)) {
        // Cosmetic only. Update in place and leave the history alone.
        return tx.decisionRule.update({ where: { id }, data });
      }

      const now = new Date();
      const next = current.version + 1;

      await tx.decisionRuleVersion.updateMany({
        where: { ruleId: id, effectiveTo: null },
        data: { effectiveTo: now },
      });

      const updated = await tx.decisionRule.update({
        where: { id },
        data: { ...data, version: next, effectiveFrom: now },
      });

      await tx.decisionRuleVersion.create({
        data: versionRow(updated, next, "UPDATE", now, meta),
      });
      return updated;
    });
  }

  /**
   * Withdraw a rule without destroying what it did.
   *
   * This is what DELETE means here, and the reason is the same one that
   * turned customer deletion into archiving: the records are the point.
   * A deleted rule row cascades its versions away, and every loan whose
   * approval cites it is left pointing at nothing — the decisions do not
   * become wrong, they become unexplainable, which for a lender is
   * worse.
   *
   * A retired rule is inert: excluded from `list` and `listActive`, so
   * it evaluates against nothing and shows nowhere. Its history stays
   * queryable by id, which is exactly how a stamped decision reaches it.
   */
  async retire(id: string, meta: RuleChangeMeta = {}): Promise<DecisionRule> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.decisionRule.findUnique({ where: { id } });
      if (!current) throw new DecisionRuleNotFoundError(id);
      if (current.retiredAt) return current; // Idempotent.

      const now = new Date();
      const next = current.version + 1;

      await tx.decisionRuleVersion.updateMany({
        where: { ruleId: id, effectiveTo: null },
        data: { effectiveTo: now },
      });

      const retired = await tx.decisionRule.update({
        where: { id },
        data: {
          active: false,
          retiredAt: now,
          version: next,
          effectiveFrom: now,
        },
      });

      /*
       * The closing version carries `effectiveTo` set to its own
       * `effectiveFrom`: a zero-width window, because this text of the
       * rule was never in force. It exists to record the withdrawal —
       * who, when, why — not to describe a period.
       */
      await tx.decisionRuleVersion.create({
        data: {
          ...versionRow(retired, next, "RETIRE", now, meta),
          effectiveTo: now,
        },
      });
      return retired;
    });
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
      await this.create(r, { changeNote: "Seeded default." });
      created += 1;
    }
    return { created, existing };
  }

  /** Convert DB rows into the shape `evaluateRules` expects. */
  toEvaluable(rows: DecisionRule[]): RuleData[] {
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      priority: r.priority,
      conditions: r.conditions as unknown as DecisioningCondition[],
      action: r.action,
      reason: r.reason ?? undefined,
      active: r.active,
    }));
  }

  /**
   * Replay a historical rule set through the same evaluator.
   *
   * `asOf` returns rows; this makes them runnable, so "what would the
   * March rules have said about this application?" is a real question
   * with a computed answer rather than a reading exercise.
   */
  versionsToEvaluable(rows: DecisionRuleVersion[]): RuleData[] {
    return rows.map((v) => ({
      id: v.ruleId,
      name: v.ruleName,
      version: v.version,
      priority: v.priority,
      conditions: v.conditions as unknown as DecisioningCondition[],
      action: v.action,
      reason: v.reason ?? undefined,
      active: v.active,
    }));
  }
}

export class DecisionRuleNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Decision rule ${id} not found.`);
    this.name = "DecisionRuleNotFoundError";
  }
}

export class DecisionRuleRetiredError extends Error {
  constructor(public readonly id: string) {
    super(`Decision rule ${id} is retired and can no longer be edited.`);
    this.name = "DecisionRuleRetiredError";
  }
}

/** The frozen copy written for a version. */
function versionRow(
  rule: DecisionRule,
  version: number,
  changeType: "CREATE" | "UPDATE" | "RETIRE",
  effectiveFrom: Date,
  meta: RuleChangeMeta,
): Prisma.DecisionRuleVersionUncheckedCreateInput {
  return {
    ruleId: rule.id,
    version,
    ruleName: rule.name,
    description: rule.description,
    priority: rule.priority,
    conditions: rule.conditions as never,
    action: rule.action,
    reason: rule.reason,
    active: rule.active,
    effectiveFrom,
    changeType,
    changeNote: meta.changeNote,
    changedById: meta.changedById,
  };
}

/** Did this edit change what the rule DOES? */
function decisiveChange(
  before: DecisionRule,
  after: Partial<DecisionRule>,
): boolean {
  return DECISIVE.some((f) => !sameValue(before[f], after[f]));
}

/**
 * Conditions arrive as parsed JSON, so identity is useless and `===` on
 * an array is always false. Serialising with sorted keys means an edit
 * that reorders a condition object's properties — which every round trip
 * through JSON.parse can do — does not read as a change to the rule.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined)
    return false;
  if (typeof a === "object" || typeof b === "object")
    return stable(a) === stable(b);
  return false;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = o[k];
          return acc;
        }, {});
    }
    return v;
  });
}
