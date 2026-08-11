import type {
  PreAssessment as PreAssessmentRow,
  PreAssessmentRepository,
  PreAssessmentSource,
} from "@loan/db";
import type { PreAssessment } from "@loan/shared-types";

import type { AnomalyFlag } from "../../lib/anomaly";
import {
  evaluateForCustomer,
  evaluateForProspect,
  type PreDecisionDeps,
  type PreDecisionGates,
  type PreDecisionOutcome,
} from "../../lib/pre-decision";

import type { PreAssessmentInput, PreAssessmentQuery } from "./schemas";

/**
 * Pre-assessment orchestration: evaluate, persist, serialize.
 *
 * The evaluation itself is `lib/pre-decision.ts`, shared with
 * POST /loans/dry-run. What this service adds is the record — a
 * pre-assessment is quoted to a human, so it has to survive the request
 * that produced it, along with the context that explains the verdict after
 * the rules have since been edited.
 */

export type RunResult =
  | { ok: true; assessment: PreAssessment }
  | { ok: false; kind: "CustomerNotFound" };

/** Row shape as returned by the repo's list/find (customer joined in). */
type RowWithCustomer = PreAssessmentRow & {
  customer?: {
    id: string;
    number: string;
    firstName: string;
    lastName: string;
  } | null;
};

export class PreAssessmentService {
  constructor(
    private readonly deps: PreDecisionDeps,
    private readonly repo: PreAssessmentRepository,
  ) {}

  /**
   * Run the rules and save the result.
   *
   * `source` comes from the route, never the body: PORTAL for the borrower
   * endpoint, OFFICER for the staff one. A borrower must not be able to
   * post an assessment that reads as staff-run.
   */
  async run(args: {
    input: PreAssessmentInput;
    source: PreAssessmentSource;
    actorId: string;
  }): Promise<RunResult> {
    const { input } = args;
    const terms = {
      productCode: input.productCode,
      principal: input.principal,
      termMonths: input.termMonths,
      annualInterestRate: input.annualInterestRate,
    };

    // A customerId always wins over the prospect fields — if the subject is
    // on file, their real score / AML / KYC beat anything hand-typed.
    const outcome: PreDecisionOutcome | null = input.customerId
      ? await evaluateForCustomer(this.deps, input.customerId, terms)
      : await evaluateForProspect(
          this.deps,
          {
            // Guaranteed present by the schema's refine() in this branch.
            monthlyIncome: input.monthlyIncome!,
            applicantAge: input.applicantAge!,
          },
          terms,
        );

    if (!outcome) return { ok: false, kind: "CustomerNotFound" };

    const row = await this.repo.create({
      source: args.source,
      customerId: input.customerId ?? null,
      // Kept even when a customerId was supplied: an officer may have
      // typed a walk-in's details before finding their existing record,
      // and what was entered is part of what happened.
      prospectName: input.prospectName ?? null,
      prospectPhone: input.prospectPhone ?? null,
      prospectEmail: input.prospectEmail ?? null,
      ...terms,
      monthlyIncome: outcome.context.monthlyIncome,
      applicantAge: outcome.context.customerAge,
      verdict: outcome.verdict,
      reason: outcome.reason,
      matchedRuleId: outcome.matchedRule?.id ?? null,
      matchedRuleName: outcome.matchedRule?.name ?? null,
      matchedRuleVersion: outcome.matchedRule?.version ?? null,
      context: outcome.context,
      gates: outcome.gates,
      anomalies: outcome.anomalies,
      createdById: args.actorId,
    });

    return { ok: true, assessment: toWire(row) };
  }

  async list(filter: PreAssessmentQuery): Promise<PreAssessment[]> {
    const rows = await this.repo.list(filter);
    return (rows as RowWithCustomer[]).map(toWire);
  }

  /** A single customer's history, newest first. Backs the portal list. */
  async listForCustomer(customerId: string): Promise<PreAssessment[]> {
    const rows = await this.repo.listForCustomer(customerId);
    return rows.map(toWire);
  }

  /**
   * Link an assessment to the application it became. Throws on an unknown
   * id or a loan another assessment already claimed (`loanId` is unique) —
   * callers treat this as best-effort, since the loan itself is committed
   * by the time they get here.
   */
  markConverted(id: string, loanId: string) {
    return this.repo.markConverted(id, loanId);
  }

  async get(idOrNumber: string): Promise<PreAssessment | null> {
    // No cast: `RowWithCustomer.customer` is optional, so the repo's
    // declared return type already satisfies toWire's parameter.
    const row = await this.repo.findByIdOrNumber(idOrNumber);
    return row ? toWire(row) : null;
  }
}

/**
 * Prisma row → wire shape. Two things happen here beyond field copying:
 *
 *   • Decimals become numbers. The column types mirror LoanApplication's
 *     precision, but the clients all do arithmetic on these, and a
 *     JSON-serialized Decimal arrives as a string.
 *   • `basis` is derived rather than stored. It's a restatement of "did
 *     this row have a Customer row behind it", and a stored copy would be
 *     one more thing that could disagree with `customerId`.
 */
function toWire(row: RowWithCustomer): PreAssessment {
  return {
    id: row.id,
    number: row.number,
    source: row.source,
    customerId: row.customerId,
    prospectName: row.prospectName,
    prospectPhone: row.prospectPhone,
    prospectEmail: row.prospectEmail,
    productCode: row.productCode,
    principal: Number(row.principal),
    termMonths: row.termMonths,
    annualInterestRate: Number(row.annualInterestRate),
    monthlyIncome: Number(row.monthlyIncome),
    applicantAge: row.applicantAge,
    verdict: row.verdict,
    reason: row.reason,
    matchedRuleId: row.matchedRuleId,
    matchedRuleName: row.matchedRuleName,
    matchedRuleVersion: row.matchedRuleVersion,
    basis: row.customerId ? "FULL" : "INDICATIVE",
    gates: (row.gates as PreDecisionGates | null) ?? null,
    anomalies: (row.anomalies as AnomalyFlag[] | null) ?? [],
    context: contextToWire(row),
    loanId: row.loanId,
    convertedAt: row.convertedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    customer: row.customer ?? null,
  };
}

/**
 * The stored DecisioningContext, renamed to the field names the UI already
 * uses for /loans/dry-run (`creditScoreAtApply` → `creditScore`,
 * `tierAtApply` → `tier`) so one component can render either.
 */
function contextToWire(row: RowWithCustomer): PreAssessment["context"] {
  const ctx = (row.context ?? {}) as Record<string, unknown>;
  return {
    principal: Number(row.principal),
    termMonths: row.termMonths,
    annualInterestRate: Number(row.annualInterestRate),
    productCode: row.productCode,
    creditScore: (ctx.creditScoreAtApply as number | null) ?? null,
    tier: (ctx.tierAtApply as PreAssessment["context"]["tier"]) ?? null,
    monthlyIncome: Number(row.monthlyIncome),
    existingActiveLoans: (ctx.existingActiveLoans as number | undefined) ?? 0,
  };
}
