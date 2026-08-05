/**
 * Pre-assessment persistence. Each run of the rules engine against a
 * prospective loan produces one row; rows are immutable except for the
 * conversion pointer set when the assessment becomes a real application.
 *
 * The evaluation itself lives in the API service — this repo only stores
 * what came out of it, plus the context snapshot that explains it.
 */

import type {
  PreAssessment,
  PreAssessmentSource,
  PreAssessmentVerdict,
  PrismaClient,
} from "@prisma/client";

import {
  idOrNumberWhere,
  nextPreAssessmentNumber,
} from "../lib/reference-numbers";

export interface PreAssessmentCreateInput {
  source: PreAssessmentSource;
  /** Set whenever the subject has a Customer row; null for a walk-in. */
  customerId?: string | null;
  prospectName?: string | null;
  prospectPhone?: string | null;
  prospectEmail?: string | null;

  productCode: string;
  principal: number;
  termMonths: number;
  /** Annual rate as a decimal (0.24 = 24% APR). */
  annualInterestRate: number;
  monthlyIncome: number;
  applicantAge: number;

  verdict: PreAssessmentVerdict;
  reason: string;
  matchedRuleId?: string | null;
  matchedRuleName?: string | null;
  /** DecisioningContext as evaluated. */
  context: unknown;
  /** AML / KYC gates. Omit for prospect rows — there's nothing to gate. */
  gates?: unknown;
  anomalies?: unknown;

  createdById?: string | null;
}

export interface PreAssessmentListFilter {
  customerId?: string;
  source?: PreAssessmentSource;
  verdict?: PreAssessmentVerdict;
  /** Case-insensitive match on the number or the prospect's name. */
  q?: string;
  /** Default 50. The list view is a recent-activity feed, not an export. */
  take?: number;
}

export class PreAssessmentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: PreAssessmentCreateInput): Promise<PreAssessment> {
    const number = await nextPreAssessmentNumber(this.prisma);
    return this.prisma.preAssessment.create({
      data: {
        number,
        source: input.source,
        customerId: input.customerId ?? null,
        prospectName: input.prospectName ?? null,
        prospectPhone: input.prospectPhone ?? null,
        prospectEmail: input.prospectEmail ?? null,
        productCode: input.productCode,
        principal: input.principal,
        termMonths: input.termMonths,
        annualInterestRate: input.annualInterestRate,
        monthlyIncome: input.monthlyIncome,
        applicantAge: input.applicantAge,
        verdict: input.verdict,
        reason: input.reason,
        matchedRuleId: input.matchedRuleId ?? null,
        matchedRuleName: input.matchedRuleName ?? null,
        context: input.context as never,
        gates: (input.gates ?? null) as never,
        anomalies: (input.anomalies ?? null) as never,
        createdById: input.createdById ?? null,
      },
    });
  }

  list(filter: PreAssessmentListFilter = {}): Promise<PreAssessment[]> {
    const q = filter.q?.trim();
    return this.prisma.preAssessment.findMany({
      where: {
        customerId: filter.customerId,
        source: filter.source,
        verdict: filter.verdict,
        ...(q
          ? {
              OR: [
                { number: { contains: q, mode: "insensitive" as const } },
                { prospectName: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: filter.take ?? 50,
      include: {
        customer: {
          select: { id: true, number: true, firstName: true, lastName: true },
        },
      },
    });
  }

  /**
   * A customer's own history — the portal's "past checks" list and the
   * officer-side customer view both read this.
   */
  listForCustomer(customerId: string, take = 20): Promise<PreAssessment[]> {
    return this.prisma.preAssessment.findMany({
      where: { customerId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  findByIdOrNumber(idOrNumber: string): Promise<PreAssessment | null> {
    return this.prisma.preAssessment.findFirst({
      where: idOrNumberWhere(idOrNumber),
      include: {
        customer: {
          select: { id: true, number: true, firstName: true, lastName: true },
        },
      },
    });
  }

  /**
   * Link an assessment to the application it became. `loanId` is unique, so
   * a second assessment pointed at the same loan is rejected by the DB
   * rather than silently overwriting the first one's claim.
   */
  markConverted(id: string, loanId: string): Promise<PreAssessment> {
    return this.prisma.preAssessment.update({
      where: { id },
      data: { loanId, convertedAt: new Date() },
    });
  }
}
