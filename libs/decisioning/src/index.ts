/**
 * @loan/decisioning — automated loan approval rule engine.
 *
 * Rules are { name, priority, conditions, action, reason }. Conditions
 * are a flat array of `{ field, op, value }` predicates that are AND-ed.
 * The first rule (lowest priority number first) whose conditions all
 * match decides the loan's initial status.
 *
 * No nested AND/OR/NOT — start simple. If a rule needs OR semantics,
 * write two rules. Real engines (Drools, JSON Logic) can wait until the
 * 50-rule mark.
 */

export type DecisioningOp =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'not_in';

export type DecisioningValue = string | number | boolean | Array<string | number>;

export interface DecisioningCondition {
  field: string;
  op: DecisioningOp;
  value: DecisioningValue;
}

export type RuleAction = 'AUTO_APPROVE' | 'AUTO_REJECT' | 'MANUAL_REVIEW';

export interface DecisionRule {
  id: string;
  name: string;
  priority: number;
  /** ALL conditions must match. */
  conditions: DecisioningCondition[];
  action: RuleAction;
  reason?: string;
  active: boolean;
}

/**
 * Context passed in at apply-time. Pulled from the customer / score /
 * AML / KYC / loan-count queries the route already runs.
 */
export interface DecisioningContext {
  productCode: string;
  principal: number;
  termMonths: number;
  annualInterestRate: number;
  tierAtApply: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  creditScoreAtApply: number | null;
  amlStatus: 'PENDING' | 'CLEAR' | 'MATCH' | 'REVIEW' | 'OVERRIDDEN' | null;
  kycComplete: boolean;
  customerAge: number;
  monthlyIncome: number;
  /** Customer's count of currently-active loans (excluding this one). */
  existingActiveLoans: number;
}

export interface DecisioningResult {
  action: RuleAction;
  /** Rule that fired, or null when no rule matched. */
  matched: DecisionRule | null;
  /** First-match reason; falls back to rule.name. */
  reason: string;
}

/** All fields the DSL recognises. UI uses this to drive the rule editor. */
export const DECISIONING_FIELDS: ReadonlyArray<{
  field: keyof DecisioningContext;
  type: 'string' | 'number' | 'boolean';
  values?: ReadonlyArray<string>;
}> = [
  { field: 'productCode', type: 'string' },
  { field: 'principal', type: 'number' },
  { field: 'termMonths', type: 'number' },
  { field: 'annualInterestRate', type: 'number' },
  { field: 'tierAtApply', type: 'string', values: ['A', 'B', 'C', 'D', 'F'] },
  { field: 'creditScoreAtApply', type: 'number' },
  { field: 'amlStatus', type: 'string', values: ['CLEAR', 'PENDING', 'MATCH', 'REVIEW', 'OVERRIDDEN'] },
  { field: 'kycComplete', type: 'boolean' },
  { field: 'customerAge', type: 'number' },
  { field: 'monthlyIncome', type: 'number' },
  { field: 'existingActiveLoans', type: 'number' },
];

/**
 * Apply rules in priority order. Returns the first match, or MANUAL_REVIEW
 * if no rule matches (which is the safe default).
 */
export function evaluateRules(
  rules: DecisionRule[],
  ctx: DecisioningContext,
): DecisioningResult {
  const sorted = rules
    .filter((r) => r.active)
    .sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (rule.conditions.every((c) => matchesCondition(c, ctx))) {
      return {
        action: rule.action,
        matched: rule,
        reason: rule.reason ?? rule.name,
      };
    }
  }
  return {
    action: 'MANUAL_REVIEW',
    matched: null,
    reason: 'No rule matched; routed to manual review.',
  };
}

function matchesCondition(c: DecisioningCondition, ctx: DecisioningContext): boolean {
  const actual = (ctx as unknown as Record<string, unknown>)[c.field];
  switch (c.op) {
    case '=':  return actual === c.value;
    case '!=': return actual !== c.value;
    case '<':  return typeof actual === 'number' && typeof c.value === 'number' && actual < c.value;
    case '<=': return typeof actual === 'number' && typeof c.value === 'number' && actual <= c.value;
    case '>':  return typeof actual === 'number' && typeof c.value === 'number' && actual > c.value;
    case '>=': return typeof actual === 'number' && typeof c.value === 'number' && actual >= c.value;
    case 'in':     return Array.isArray(c.value) && (c.value as Array<unknown>).includes(actual as never);
    case 'not_in': return Array.isArray(c.value) && !(c.value as Array<unknown>).includes(actual as never);
    default: return false;
  }
}

/**
 * Sensible default rules to seed a fresh deployment. Tunable per-lender,
 * but a reasonable starting policy:
 *
 *   10  · AML hard-block         AUTO_REJECT
 *   20  · KYC missing            MANUAL_REVIEW (don't auto-reject; customer can complete)
 *   30  · F tier                 AUTO_REJECT
 *   40  · D tier > 50k           MANUAL_REVIEW
 *   100 · A tier ≤ 200k + clean  AUTO_APPROVE
 *   110 · B tier ≤ 100k + clean  AUTO_APPROVE
 *   1000 · catch-all             MANUAL_REVIEW
 */
export const DEFAULT_RULES: Omit<DecisionRule, 'id'>[] = [
  {
    name: 'AML hard-block',
    priority: 10,
    conditions: [{ field: 'amlStatus', op: '=', value: 'MATCH' }],
    action: 'AUTO_REJECT',
    reason: 'Customer has an unresolved AML match.',
    active: true,
  },
  {
    name: 'KYC incomplete → manual',
    priority: 20,
    conditions: [{ field: 'kycComplete', op: '=', value: false }],
    action: 'MANUAL_REVIEW',
    reason: 'KYC documents incomplete.',
    active: true,
  },
  {
    name: 'F tier auto-reject',
    priority: 30,
    conditions: [{ field: 'tierAtApply', op: '=', value: 'F' }],
    action: 'AUTO_REJECT',
    reason: 'Credit tier F is below underwriting threshold.',
    active: true,
  },
  {
    name: 'D tier large amount → manual',
    priority: 40,
    conditions: [
      { field: 'tierAtApply', op: '=', value: 'D' },
      { field: 'principal', op: '>', value: 50_000 },
    ],
    action: 'MANUAL_REVIEW',
    reason: 'Tier D applicant requesting > ₱50k — needs officer review.',
    active: true,
  },
  {
    name: 'A tier fast-track',
    priority: 100,
    conditions: [
      { field: 'tierAtApply', op: '=', value: 'A' },
      { field: 'principal', op: '<=', value: 200_000 },
      { field: 'amlStatus', op: 'in', value: ['CLEAR', 'OVERRIDDEN'] },
      { field: 'kycComplete', op: '=', value: true },
    ],
    action: 'AUTO_APPROVE',
    reason: 'Tier A applicant, principal ≤ ₱200k, KYC verified, AML clear.',
    active: true,
  },
  {
    name: 'B tier moderate fast-track',
    priority: 110,
    conditions: [
      { field: 'tierAtApply', op: '=', value: 'B' },
      { field: 'principal', op: '<=', value: 100_000 },
      { field: 'amlStatus', op: 'in', value: ['CLEAR', 'OVERRIDDEN'] },
      { field: 'kycComplete', op: '=', value: true },
    ],
    action: 'AUTO_APPROVE',
    reason: 'Tier B applicant, principal ≤ ₱100k, KYC verified, AML clear.',
    active: true,
  },
];
