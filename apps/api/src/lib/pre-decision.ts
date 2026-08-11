/**
 * "What would the rules engine say?" — evaluated without creating a loan.
 *
 * Two callers share this:
 *
 *   • POST /loans/dry-run    — the officer's new-loan wizard, previewing an
 *                              in-flight application. Nothing is stored.
 *   • POST /pre-assessments  — a saved pre-application check, from the
 *     POST /portal/pre-assessments   borrower portal or from staff.
 *
 * Keeping one implementation matters more than the ~40 lines it saves: a
 * borrower who is told "you'd likely be approved" and an officer looking at
 * the same figures must not see different verdicts because two copies of
 * the context builder drifted apart.
 *
 * Two entry points, because the inputs genuinely differ:
 *
 *   evaluateForCustomer()  reads score, AML status, KYC and active-loan
 *                          count off a real Customer row. Complete picture.
 *   evaluateForProspect()  has none of those — the caller typed in an income
 *                          and an age and nothing else exists. The context
 *                          carries nulls and `kycComplete: false`, which is
 *                          honest but means rules gated on KYC will fire.
 *                          Callers must present the result as indicative.
 */

import type {
  CreditScoreRepository,
  DecisionRuleRepository,
  KycRepository,
  PrismaClient,
  ScreeningRepository,
} from "@loan/db";
import {
  evaluateRules,
  type DecisioningContext,
  type RuleAction,
} from "@loan/decisioning";
import { validateKyc, type KycDocumentType } from "@loan/kyc";

import { computeAnomalyFlags, type AnomalyFlag } from "./anomaly";

/** The loan being asked about. Same four fields in both entry points. */
export interface PreDecisionTerms {
  productCode: string;
  principal: number;
  termMonths: number;
  /** Annual rate as a decimal (0.24 = 24% APR). */
  annualInterestRate: number;
}

export interface PreDecisionDeps {
  prisma: PrismaClient;
  screening: ScreeningRepository;
  scores: CreditScoreRepository;
  kyc: KycRepository;
  rules: DecisionRuleRepository;
}

/**
 * Blocking conditions that are NOT decisioning rules — they're hard-coded
 * in the apply + decide handlers. Surfaced separately so the UI can render
 * them as pre-flight checks rather than burying them in a verdict.
 */
export interface PreDecisionGates {
  amlMatch: boolean;
  kycComplete: boolean;
  missingKycDocs: KycDocumentType[];
  rejectedKycDocs: KycDocumentType[];
}

export type PreDecisionVerdict = "APPROVE" | "REVIEW" | "REJECT";

export interface PreDecisionOutcome {
  verdict: PreDecisionVerdict;
  reason: string;
  matchedRule: { id: string; name: string; version: number } | null;
  /** Null for a prospect — no customer, so nothing to gate on. */
  gates: PreDecisionGates | null;
  anomalies: AnomalyFlag[];
  context: DecisioningContext;
}

/**
 * Rule action → the three outcomes the UI shows. MANUAL_REVIEW and "no rule
 * matched" both land on REVIEW: in either case a human decides.
 */
export function toVerdict(action: RuleAction): PreDecisionVerdict {
  if (action === "AUTO_APPROVE") return "APPROVE";
  if (action === "AUTO_REJECT") return "REJECT";
  return "REVIEW";
}

/**
 * Evaluate against an existing customer's real record. Returns null when
 * the customer id doesn't resolve, so callers can map that to a 404.
 */
export async function evaluateForCustomer(
  deps: PreDecisionDeps,
  customerId: string,
  terms: PreDecisionTerms,
): Promise<PreDecisionOutcome | null> {
  // All six lookups are independent. The dry-run path hits this on every
  // debounced keystroke in the wizard, so they run in parallel.
  const [latestScreen, score, customer, docs, product, activeLoans] =
    await Promise.all([
      deps.screening.latestForCustomer(customerId),
      deps.scores.latestForCustomer(customerId),
      deps.prisma.customer.findUnique({ where: { id: customerId } }),
      deps.kyc.listForCustomer(customerId),
      deps.prisma.loanProduct.findUnique({
        where: { code: terms.productCode },
      }),
      deps.prisma.loanApplication.count({
        where: {
          customerId,
          status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] },
        },
      }),
    ]);

  if (!customer) return null;

  const extras = (product?.requiredKycDocs ?? []) as KycDocumentType[];
  const kycRes = validateKyc(docs, extras);

  const context: DecisioningContext = {
    ...terms,
    tierAtApply: score?.tier ?? null,
    creditScoreAtApply: score?.score ?? null,
    amlStatus: latestScreen?.status ?? null,
    kycComplete: kycRes.complete,
    customerAge: ageFrom(customer.dateOfBirth),
    monthlyIncome: Number(customer.monthlyIncome),
    existingActiveLoans: activeLoans,
  };

  return finish(deps, context, {
    customerId,
    gates: {
      amlMatch: latestScreen?.status === "MATCH",
      kycComplete: kycRes.complete,
      missingKycDocs: kycRes.missing,
      rejectedKycDocs: kycRes.rejected,
    },
  });
}

/**
 * Evaluate for someone with no Customer row — a walk-in the officer is
 * sizing up, before any record exists.
 *
 * Everything the lender would normally know is absent: no credit score, no
 * AML screen, no KYC pack, no loan history. Those are passed as nulls and
 * `kycComplete: false` rather than as optimistic defaults, so any rule
 * gated on them fires as it would for a genuinely unverified applicant.
 * The verdict is therefore conservative by construction, and callers must
 * label it as indicative rather than as a decision.
 */
export async function evaluateForProspect(
  deps: PreDecisionDeps,
  subject: { monthlyIncome: number; applicantAge: number },
  terms: PreDecisionTerms,
): Promise<PreDecisionOutcome> {
  const context: DecisioningContext = {
    ...terms,
    tierAtApply: null,
    creditScoreAtApply: null,
    amlStatus: null,
    kycComplete: false,
    customerAge: subject.applicantAge,
    monthlyIncome: subject.monthlyIncome,
    existingActiveLoans: 0,
  };

  return finish(deps, context, { gates: null });
}

// ─── internals ──────────────────────────────────────────────────────

/**
 * The half both paths share: run the active rules over the assembled
 * context, then collect anomaly flags for the same figures.
 */
async function finish(
  deps: PreDecisionDeps,
  context: DecisioningContext,
  extra: { customerId?: string; gates: PreDecisionGates | null },
): Promise<PreDecisionOutcome> {
  const ruleRows = await deps.rules.listActive();
  const decision = evaluateRules(deps.rules.toEvaluable(ruleRows), context);

  const anomalies = await computeAnomalyFlags(deps.prisma, {
    customerId: extra.customerId,
    productCode: context.productCode,
    principal: context.principal,
    termMonths: context.termMonths,
    annualInterestRate: context.annualInterestRate,
    monthlyIncome: context.monthlyIncome,
  });

  return {
    verdict: toVerdict(decision.action),
    reason: decision.reason,
    matchedRule: decision.matched
      ? {
          id: decision.matched.id,
          name: decision.matched.name,
          version: decision.matched.version,
        }
      : null,
    gates: extra.gates,
    anomalies,
    context,
  };
}

/** Whole years since `dob`. Leap years averaged in, same as the old inline. */
function ageFrom(dob: Date): number {
  return Math.floor((Date.now() - dob.getTime()) / (365.25 * 86_400_000));
}
