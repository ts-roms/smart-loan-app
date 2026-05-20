import type { CreditTier, PrismaClient, SurveyResponse } from '@prisma/client';

export interface SaveResponseInput {
  customerId: string;
  answers: Record<string, string | number | boolean>;
  score: number;
  tier: CreditTier;
  breakdown: unknown;
  computedById: string;
}

export class SurveyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  listForCustomer(customerId: string): Promise<SurveyResponse[]> {
    return this.prisma.surveyResponse.findMany({
      where: { customerId },
      orderBy: { computedAt: 'desc' },
    });
  }

  saveResponse(input: SaveResponseInput): Promise<SurveyResponse> {
    return this.prisma.surveyResponse.create({
      data: {
        customerId: input.customerId,
        answers: input.answers as never,
        score: input.score,
        tier: input.tier,
        breakdown: input.breakdown as never,
        computedById: input.computedById,
      },
    });
  }
}
