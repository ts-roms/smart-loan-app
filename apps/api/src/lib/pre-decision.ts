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
  CustomerExposureRepository,
  DecisionRuleRepository,
  ExposureForDecision,
  KycRepository,
  PrismaClient,
  ScreeningRepository,
} from "@loan/db";
import {
  assessAffordability,
  evaluateRules,
  type DecisioningContext,
  type RuleAction,
} from "@loan/decisioning";
import { validateKyc, type KycDocumentType } from "@loan/kyc";
import {
  computeAmortizationFor,
  periodsPerYear,
  type InterestMethod,
  type PaymentFrequency,
} from "@loan/loans";

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
  /**
   * Consolidated exposure (§53). Injected rather than constructed from
   * `prisma` so the whole borrower book stays one query path — the
   * repository is the only thing in the codebase allowed to answer
   * "what is this member already into us for", and a second assembly
   * here would be exactly the drift its own header warns about.
   */
  exposure: CustomerExposureRepository;
}

/**
 * Product fields the instalment depends on. A bare shape rather than
 * the Prisma row so both callers — one of which already has the row,
 * one of which does not — can satisfy it, and so a missing product
 * degrades to the same defaults `/loans/quote` uses.
 */
export interface InstallmentProduct {
  interestMethod: InterestMethod;
  paymentFrequency: PaymentFrequency;
}

/**
 * What this application would cost the borrower per month.
 *
 * Built from the same `computeAmortizationFor` that writes the real
 * schedule at disbursement, with the product's own interest method and
 * payment frequency — not a declining-balance approximation. A FLAT
 * product's instalment is materially larger than the declining formula
 * suggests, and a DTI computed off the wrong one is wrong in the
 * lenient direction on exactly the products PH coops sell most.
 *
 * Normalised to a MONTHLY figure, because §16's disposable income is
 * monthly and a weekly loan's ₱500 instalment is not comparable to a
 * monthly loan's ₱500 one. A bi-weekly loan costs 26/12 of its
 * instalment each month; a weekly one 52/12.
 */
export function newLoanInstallment(
  terms: PreDecisionTerms,
  product: InstallmentProduct | null,
): number {
  const method = product?.interestMethod ?? "DECLINING";
  const frequency = product?.paymentFrequency ?? "MONTHLY";
  const schedule = computeAmortizationFor(
    terms.principal,
    terms.annualInterestRate,
    terms.termMonths,
    { method, frequency },
  );
  // The contractual instalment is the first row's. The last row absorbs
  // rounding drift and is a few centavos off by construction, so it is
  // the wrong one to quote a borrower's monthly commitment from.
  const perPeriod = schedule[0]?.payment ?? 0;
  const monthly = perPeriod * (periodsPerYear(frequency) / 12);
  return Number.isFinite(monthly) ? Math.round(monthly * 100) / 100 : 0;
}

/** The §53 + §16 half of the context, and the only place it is built. */
export type ExposureContext = Pick<
  DecisioningContext,
  | "existingExposure"
  | "existingExposureOutstanding"
  | "existingPastDue"
  | "existingExposureLoans"
  | "existingWrittenOff"
  | "totalExposureAfterLoan"
  | "existingMonthlyObligations"
  | "newLoanInstallment"
  | "disposableIncome"
  | "debtToIncomeRatio"
>;

/**
 * Fold a borrower's consolidated exposure into the fields the rules can
 * see, and run §16 over the result.
 *
 * One implementation, three callers — `apply()`, `/loans/dry-run` and
 * `/pre-assessments`. That is not tidiness: a borrower told "you'd
 * likely be approved" by the preview and then declined on submission,
 * because two copies of this fold disagreed about what their other
 * loans cost, is the specific failure this file already exists to
 * prevent for every other input.
 *
 * ─── Where §16's four terms come from ───────────────────────────────
 *
 *   Net Salary          `Customer.monthlyIncome`, the only verified
 *                       income figure on the record.
 *   Qualifying Income   0. There is no second income column, and no
 *                       schema change is in scope to add one. Passed
 *                       explicitly rather than folded away so the term
 *                       is visible on the decision record as a zero
 *                       someone chose, not one nobody noticed.
 *   Existing Obligations  the monthly cost of the borrower's live
 *                       loans — see `forDecision`.
 *   Payroll Deductions  0, same reason as qualifying income. Nothing
 *                       in the schema records SSS / PhilHealth /
 *                       Pag-IBIG per member.
 *
 * The two zeros pull disposable income UP, i.e. they make the borrower
 * look more affordable than they are. That is the wrong direction to be
 * wrong in, and it is stated here rather than hidden: it is still
 * strictly better than the previous state, where existing obligations
 * were zero too.
 */
export function buildExposureContext(args: {
  snapshot: ExposureForDecision | null;
  monthlyIncome: number;
  principal: number;
  newLoanInstallment: number;
}): ExposureContext {
  const total = args.snapshot?.exposure.total;
  const excluded = args.snapshot?.exposure.excluded;
  const existingExposure = total?.principalOutstanding ?? 0;

  const affordability = assessAffordability({
    netSalary: args.monthlyIncome,
    qualifyingIncome: 0,
    existingObligations: args.snapshot?.monthlyObligations ?? 0,
    payrollDeductions: 0,
    newLoanInstallment: args.newLoanInstallment,
  });

  return {
    existingExposure,
    existingExposureOutstanding: total?.outstanding ?? 0,
    existingPastDue: total?.pastDue ?? 0,
    existingExposureLoans: total?.activeLoans ?? 0,
    existingWrittenOff: excluded?.writtenOffPrincipal ?? 0,
    totalExposureAfterLoan:
      Math.round((existingExposure + args.principal) * 100) / 100,
    existingMonthlyObligations: affordability.existingObligations,
    newLoanInstallment: affordability.newLoanInstallment,
    disposableIncome: affordability.disposableIncome,
    debtToIncomeRatio: affordability.debtToIncomeRatio,
  };
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
  // All seven lookups are independent. The dry-run path hits this on
  // every debounced keystroke in the wizard, so they run in parallel —
  // exposure included: it is a decisioning input like any other and
  // sequencing it behind the rest would show up as wizard lag.
  const [latestScreen, score, customer, docs, product, activeLoans, exposure] =
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
      deps.exposure.forDecision(customerId),
    ]);

  if (!customer) return null;

  const extras = (product?.requiredKycDocs ?? []) as KycDocumentType[];
  const kycRes = validateKyc(docs, extras);
  const monthlyIncome = Number(customer.monthlyIncome);

  const context: DecisioningContext = {
    ...terms,
    tierAtApply: score?.tier ?? null,
    creditScoreAtApply: score?.score ?? null,
    amlStatus: latestScreen?.status ?? null,
    kycComplete: kycRes.complete,
    customerAge: ageFrom(customer.dateOfBirth),
    monthlyIncome,
    existingActiveLoans: activeLoans,
    ...buildExposureContext({
      snapshot: exposure,
      monthlyIncome,
      principal: terms.principal,
      newLoanInstallment: newLoanInstallment(terms, product),
    }),
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
  /*
   * The product is fetched — the only lookup on this path — so the
   * quoted instalment uses the product's real interest method. A
   * prospect being sized up for a FLAT product would otherwise be told
   * a declining-balance instalment, understating what they would
   * actually pay each month on the one figure they care about.
   */
  const product = await deps.prisma.loanProduct.findUnique({
    where: { code: terms.productCode },
  });

  const context: DecisioningContext = {
    ...terms,
    tierAtApply: null,
    creditScoreAtApply: null,
    amlStatus: null,
    kycComplete: false,
    customerAge: subject.applicantAge,
    monthlyIncome: subject.monthlyIncome,
    existingActiveLoans: 0,
    /*
     * No Customer row means no loan book to consolidate, so exposure is
     * genuinely zero rather than unknown — a prospect cannot hold a loan
     * with this lender by definition. What is unknown is debt held
     * ELSEWHERE, which this system has never seen for anybody, prospect
     * or member. Callers already label a prospect verdict indicative.
     */
    ...buildExposureContext({
      snapshot: null,
      monthlyIncome: subject.monthlyIncome,
      principal: terms.principal,
      newLoanInstallment: newLoanInstallment(terms, product),
    }),
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
