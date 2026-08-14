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
  "=" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not_in";

export type DecisioningValue =
  string | number | boolean | Array<string | number>;

export interface DecisioningCondition {
  field: string;
  op: DecisioningOp;
  value: DecisioningValue;
}

export type RuleAction = "AUTO_APPROVE" | "AUTO_REJECT" | "MANUAL_REVIEW";

export interface DecisionRule {
  id: string;
  name: string;
  /**
   * Which revision of this rule. Carried through evaluation so a
   * decision can record not just WHICH rule fired but what that rule
   * required at the time — the rule named "A-tier fast-track" a year
   * from now may demand a score this borrower never had.
   *
   * 1 for a rule that has never been edited.
   */
  version: number;
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
  tierAtApply: "A" | "B" | "C" | "D" | "F" | null;
  creditScoreAtApply: number | null;
  amlStatus: "PENDING" | "CLEAR" | "MATCH" | "REVIEW" | "OVERRIDDEN" | null;
  kycComplete: boolean;
  customerAge: number;
  monthlyIncome: number;
  /**
   * Customer's count of currently-active loans (excluding this one).
   *
   * A COUNT, and left exactly as it was. The exposure fields below
   * measure the same borrower in pesos and it is tempting to redefine
   * this in their terms — it counts DISBURSED / ACTIVE / DEFAULTED,
   * while exposure also counts APPROVED, so the two legitimately
   * disagree by one on a borrower with a granted-but-undisbursed loan.
   * Reconciling them would silently move every rule already written
   * against this field, which is the one thing adding exposure must not
   * do. They are different questions; both are answered.
   */
  existingActiveLoans: number;

  // ── Consolidated exposure (§53) ──────────────────────────────────
  //
  // What the lender is ALREADY into this borrower for, across their
  // whole book — not just the application in front of the engine.
  // Every figure comes from `consolidatedExposure` in @loan/loans via
  // the caller; nothing here recomputes a balance.
  //
  // Plain numbers rather than the ConsolidatedExposure shape on
  // purpose: the rule DSL matches on scalar fields, so anything a rule
  // can be written against has to be a scalar. It also keeps this
  // package free of a dependency on the loan-arithmetic library.

  /**
   * Principal still owed across every counted loan — APPROVED,
   * DISBURSED, ACTIVE and DEFAULTED. The §53 headline.
   *
   * Excludes CLOSED (repaid), RESTRUCTURED (superseded by a successor
   * that IS counted) and WRITTEN_OFF (already expensed to Bad Debt);
   * see `exposure.ts` for why each. Zero for a first-time borrower.
   */
  existingExposure: number;
  /** The same debt including scheduled interest still to run. */
  existingExposureOutstanding: number;
  /** Unpaid and already past due, across the whole book. */
  existingPastDue: number;
  /** How many loans `existingExposure` is made of. */
  existingExposureLoans: number;
  /**
   * What this borrower has previously had written off to Bad Debt.
   *
   * Outside `existingExposure` by construction — the receivable is gone
   * and the loss is taken — but the single most important fact about
   * the borrower, and carried here so a rule can refuse on it rather
   * than the figure being visible only on a profile page nobody opened.
   */
  existingWrittenOff: number;
  /**
   * `existingExposure + principal` — what the lender would be into this
   * borrower for if this application were granted.
   *
   * The field a total-exposure ceiling is written against. No ceiling
   * ships configured; see the note on DEFAULT_RULES.
   */
  totalExposureAfterLoan: number;

  // ── Affordability (§16) ──────────────────────────────────────────

  /**
   * Monthly amortization on debt the borrower already holds, summed
   * across the counted loans above. §16's "Existing Obligations".
   */
  existingMonthlyObligations: number;
  /** This application's own monthly amortization. */
  newLoanInstallment: number;
  /**
   * §16: net salary + qualifying income − existing obligations −
   * payroll deductions. Before the new loan, so it reads as what the
   * borrower has available to service it with.
   *
   * Negative when the borrower is already over-committed, which is not
   * clamped — see `assessAffordability`.
   */
  disposableIncome: number;
  /**
   * `(existingMonthlyObligations + newLoanInstallment) / income`.
   * Zero when income is zero — a figure, not NaN. See
   * `assessAffordability` for why that distinction is load-bearing.
   */
  debtToIncomeRatio: number;
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
  type: "string" | "number" | "boolean";
  values?: ReadonlyArray<string>;
}> = [
  { field: "productCode", type: "string" },
  { field: "principal", type: "number" },
  { field: "termMonths", type: "number" },
  { field: "annualInterestRate", type: "number" },
  { field: "tierAtApply", type: "string", values: ["A", "B", "C", "D", "F"] },
  { field: "creditScoreAtApply", type: "number" },
  {
    field: "amlStatus",
    type: "string",
    values: ["CLEAR", "PENDING", "MATCH", "REVIEW", "OVERRIDDEN"],
  },
  { field: "kycComplete", type: "boolean" },
  { field: "customerAge", type: "number" },
  { field: "monthlyIncome", type: "number" },
  { field: "existingActiveLoans", type: "number" },
  // Consolidated exposure (§53) and the affordability figures derived
  // from it (§16). Listed here so the rule editor offers them: a policy
  // an operator cannot express in the UI is one they will ask an
  // engineer to hard-code, which is what §50 exists to prevent.
  { field: "existingExposure", type: "number" },
  { field: "existingExposureOutstanding", type: "number" },
  { field: "existingPastDue", type: "number" },
  { field: "existingExposureLoans", type: "number" },
  { field: "existingWrittenOff", type: "number" },
  { field: "totalExposureAfterLoan", type: "number" },
  { field: "existingMonthlyObligations", type: "number" },
  { field: "newLoanInstallment", type: "number" },
  { field: "disposableIncome", type: "number" },
  { field: "debtToIncomeRatio", type: "number" },
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
    action: "MANUAL_REVIEW",
    matched: null,
    reason: "No rule matched; routed to manual review.",
  };
}

function matchesCondition(
  c: DecisioningCondition,
  ctx: DecisioningContext,
): boolean {
  const actual = (ctx as unknown as Record<string, unknown>)[c.field];
  switch (c.op) {
    case "=":
      return actual === c.value;
    case "!=":
      return actual !== c.value;
    case "<":
      return (
        typeof actual === "number" &&
        typeof c.value === "number" &&
        actual < c.value
      );
    case "<=":
      return (
        typeof actual === "number" &&
        typeof c.value === "number" &&
        actual <= c.value
      );
    case ">":
      return (
        typeof actual === "number" &&
        typeof c.value === "number" &&
        actual > c.value
      );
    case ">=":
      return (
        typeof actual === "number" &&
        typeof c.value === "number" &&
        actual >= c.value
      );
    case "in":
      return (
        Array.isArray(c.value) && (c.value as Array<unknown>).includes(actual)
      );
    case "not_in":
      return (
        Array.isArray(c.value) && !(c.value as Array<unknown>).includes(actual)
      );
    default:
      return false;
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
 *
 * Plus one rule that is shipped OFF — see
 * `TOTAL_EXPOSURE_CEILING_PLACEHOLDER`.
 */

/**
 * The threshold on the shipped total-exposure rule, and the reason that
 * rule is inactive.
 *
 * There is no correct single-borrower limit to ship. It is a policy
 * number — a coop's board sets it against its own capital, and §50 is
 * explicit that automation must not independently decide who is
 * approved. Picking a plausible-looking default here would mean this
 * commit started declining real borrowers on a figure nobody chose,
 * which is the one outcome wiring exposure into decisioning must not
 * produce.
 *
 * So the rule ships `active: false` AND at a threshold no application
 * reaches. Two independent reasons it cannot bite: a reviewer who
 * switches it on without reading it still changes nothing, and has to
 * type a real number before it does anything at all. The row exists so
 * that the primitive is discoverable in the rule editor rather than
 * something an operator has to know to ask for.
 */
export const TOTAL_EXPOSURE_CEILING_PLACEHOLDER = 999_999_999;

/** Version is assigned by the catalog on insert; these are the text. */
export const DEFAULT_RULES: Omit<DecisionRule, "id" | "version">[] = [
  {
    name: "AML hard-block",
    priority: 10,
    conditions: [{ field: "amlStatus", op: "=", value: "MATCH" }],
    action: "AUTO_REJECT",
    reason: "Customer has an unresolved AML match.",
    active: true,
  },
  {
    name: "KYC incomplete → manual",
    priority: 20,
    conditions: [{ field: "kycComplete", op: "=", value: false }],
    action: "MANUAL_REVIEW",
    reason: "KYC documents incomplete.",
    active: true,
  },
  {
    name: "F tier auto-reject",
    priority: 30,
    conditions: [{ field: "tierAtApply", op: "=", value: "F" }],
    action: "AUTO_REJECT",
    reason: "Credit tier F is below underwriting threshold.",
    active: true,
  },
  {
    name: "D tier large amount → manual",
    priority: 40,
    conditions: [
      { field: "tierAtApply", op: "=", value: "D" },
      { field: "principal", op: ">", value: 50_000 },
    ],
    action: "MANUAL_REVIEW",
    reason: "Tier D applicant requesting > ₱50k — needs officer review.",
    active: true,
  },
  {
    name: "A tier fast-track",
    priority: 100,
    conditions: [
      { field: "tierAtApply", op: "=", value: "A" },
      { field: "principal", op: "<=", value: 200_000 },
      { field: "amlStatus", op: "in", value: ["CLEAR", "OVERRIDDEN"] },
      { field: "kycComplete", op: "=", value: true },
    ],
    action: "AUTO_APPROVE",
    reason: "Tier A applicant, principal ≤ ₱200k, KYC verified, AML clear.",
    active: true,
  },
  {
    name: "B tier moderate fast-track",
    priority: 110,
    conditions: [
      { field: "tierAtApply", op: "=", value: "B" },
      { field: "principal", op: "<=", value: 100_000 },
      { field: "amlStatus", op: "in", value: ["CLEAR", "OVERRIDDEN"] },
      { field: "kycComplete", op: "=", value: true },
    ],
    action: "AUTO_APPROVE",
    reason: "Tier B applicant, principal ≤ ₱100k, KYC verified, AML clear.",
    active: true,
  },
  /*
   * Total consolidated exposure ceiling — SHIPPED OFF, AND UNREACHABLE.
   *
   * The §53 capability made concrete: a borrower's whole book, plus the
   * loan being asked for, tested against one number. Priority 50 puts
   * it ahead of both fast-tracks, which is where a ceiling belongs — a
   * tier-A member ₱2M into the coop should not be auto-approved past a
   * limit because their score is good.
   *
   * It decides nothing as shipped. `active: false` keeps it out of
   * `listActive()` and out of `evaluateRules`, and the threshold is
   * `TOTAL_EXPOSURE_CEILING_PLACEHOLDER` — read the note there for why
   * both, rather than either.
   *
   * MANUAL_REVIEW rather than AUTO_REJECT deliberately. Breaching a
   * concentration limit is a question for an officer — there are good
   * answers to it, like collateral or a board approval — and §50 does
   * not want the engine closing it unilaterally.
   */
  {
    name: "Total exposure ceiling (inactive — set your limit)",
    priority: 50,
    conditions: [
      {
        field: "totalExposureAfterLoan",
        op: ">",
        value: TOTAL_EXPOSURE_CEILING_PLACEHOLDER,
      },
    ],
    action: "MANUAL_REVIEW",
    reason:
      "Total exposure to this borrower would exceed the configured " +
      "single-borrower ceiling — officer review required.",
    active: false,
  },
];

// §16's disposable-income arithmetic, which turns consolidated exposure
// into the affordability fields on the context above. Pure numbers; see
// the module header for why the mapping from a loan book lives at the
// call site rather than inside it.
export {
  assessAffordability,
  type Affordability,
  type AffordabilityInput,
} from "./affordability";
