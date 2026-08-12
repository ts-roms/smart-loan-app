import type { CreditScore, CreditTier, PrismaClient } from "@prisma/client";

export interface BehaviorSignal {
  /** Total previous loans (any status). */
  priorLoans: number;
  /** Loans currently in DEFAULTED status. */
  defaults: number;
  /** Share of installments paid by due date — 0..1, null if no payments yet. */
  onTimeRate: number | null;
}

export interface UpsertLatestInput {
  customerId: string;
  score: number;
  tier: CreditTier;
  breakdown: unknown;
  sourceSurveyId?: string;
  /**
   * Which scorecard produced this score.
   *
   * `breakdown` already says what the score was MADE of — each factor's
   * label, its resolved maxPoints, the weight achieved. This says what
   * it was made BY, which is what makes two scores known to be
   * comparable and a cohort re-runnable under the catalog that scored
   * it. Null on scores computed before versioning existed.
   */
  catalogVersion?: number | null;
}

/**
 * Reads + writes the customer's "current credit score" snapshot. Behavior
 * signals (default rate, on-time rate) are computed from the loan history
 * — pulled here so the scoring engine in @loan/credit-scoring stays pure.
 */
export class CreditScoreRepository {
  constructor(private readonly prisma: PrismaClient) {}

  latestForCustomer(customerId: string): Promise<CreditScore | null> {
    return this.prisma.creditScore.findFirst({
      where: { customerId },
      orderBy: { computedAt: "desc" },
    });
  }

  /**
   * Insert a fresh score row. We don't update the previous row in place —
   * the history matters for "how did Maria's score change over time?".
   */
  upsertLatest(input: UpsertLatestInput): Promise<CreditScore> {
    return this.prisma.creditScore.create({
      data: {
        customerId: input.customerId,
        score: input.score,
        tier: input.tier,
        breakdown: input.breakdown as never,
        sourceSurveyId: input.sourceSurveyId ?? null,
        catalogVersion: input.catalogVersion ?? null,
      },
    });
  }

  /** Cheap aggregate from the loan history. Drives the "behavior" factor. */
  async behaviorSignal(customerId: string): Promise<BehaviorSignal> {
    const loans = await this.prisma.loanApplication.findMany({
      where: { customerId },
      select: { id: true, status: true },
    });
    const defaults = loans.filter((l) => l.status === "DEFAULTED").length;

    // On-time rate: payments whose paidOn <= matching schedule dueDate.
    const schedules = await this.prisma.loanSchedule.findMany({
      where: { loan: { customerId } },
      select: { id: true, dueDate: true, paidInFullAt: true },
    });
    const settled = schedules.filter((s) => s.paidInFullAt);
    const onTime = settled.filter((s) => s.paidInFullAt! <= s.dueDate).length;
    const onTimeRate = settled.length > 0 ? onTime / settled.length : null;

    return { priorLoans: loans.length, defaults, onTimeRate };
  }
}
