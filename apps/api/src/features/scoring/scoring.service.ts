import {
  computeCreditScore,
  SURVEY_QUESTIONS,
  toBureauBucket,
  toTier,
} from "@loan/credit-scoring";
import { type CreditScoreRepository, type SurveyRepository } from "@loan/db";

import type { SubmitSurveyInput } from "./schemas.js";

/**
 * Credit-scoring orchestration. The submit path is the only real
 * orchestration here — it:
 *   1. Pulls the behavior signal (on-time rate / default count) from
 *      the customer's loan history.
 *   2. Computes the score against the questionnaire + behavior.
 *   3. Persists the survey response.
 *   4. Upserts the customer's latest score so reads are fast.
 *
 * The other methods are convenience wrappers that exist purely so the
 * controller stays one-liner shaped.
 */
export class ScoringService {
  constructor(
    private readonly survey: SurveyRepository,
    private readonly scores: CreditScoreRepository,
  ) {}

  /** Static questionnaire structure — owned by @loan/credit-scoring. */
  getQuestions() {
    return SURVEY_QUESTIONS;
  }

  /**
   * Submit a completed survey + compute the resulting score in the
   * same call so the customer sees their tier immediately.
   */
  async submit(args: { input: SubmitSurveyInput; actorId: string }) {
    const { customerId, answers } = args.input;

    const behavior = await this.scores.behaviorSignal(customerId);
    const result = computeCreditScore({ answers, behavior });

    const saved = await this.survey.saveResponse({
      customerId,
      answers,
      score: result.score,
      tier: result.tier,
      breakdown: result.breakdown,
      computedById: args.actorId,
    });
    await this.scores.upsertLatest({
      customerId,
      score: result.score,
      tier: result.tier,
      breakdown: result.breakdown,
      sourceSurveyId: saved.id,
    });

    return { ...result, surveyId: saved.id };
  }

  /** Latest persisted score for a customer. */
  latestForCustomer(customerId: string) {
    return this.scores.latestForCustomer(customerId);
  }

  /** Pure score → tier/bucket lookup. No DB hit. */
  tier(score: number) {
    return { score, tier: toTier(score), bucket: toBureauBucket(score) };
  }
}
