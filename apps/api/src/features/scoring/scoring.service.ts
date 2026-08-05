import {
  computeCreditScore,
  toBureauBucket,
  toTier,
} from "@loan/credit-scoring";
import {
  type CreditScoreRepository,
  type ScoringCatalogRepository,
  type SurveyRepository,
} from "@loan/db";

import type { SubmitSurveyInput } from "./schemas";

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
    /**
     * The tenant's editable catalog. Falls back to the shipped one when
     * the tables are empty, so a tenant provisioned before the catalog
     * existed keeps scoring on the built-in questions.
     */
    private readonly catalog: ScoringCatalogRepository,
  ) {}

  /**
   * Questionnaire structure, from the tenant's catalog. Was a static
   * export; it's rows now so admins can tune the survey.
   */
  async getQuestions() {
    return (await this.catalog.activeCatalog()).questions;
  }

  /**
   * Submit a completed survey + compute the resulting score in the
   * same call so the customer sees their tier immediately.
   */
  async submit(args: { input: SubmitSurveyInput; actorId: string }) {
    const { customerId, answers } = args.input;

    const behavior = await this.scores.behaviorSignal(customerId);
    // Score against the tenant's catalog. Factor points are derived
    // from weights against a fixed total, so an edited catalog changes
    // the emphasis without moving the 300–850 scale.
    const catalog = await this.catalog.activeCatalog();
    const result = computeCreditScore({ answers, behavior, catalog });

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
