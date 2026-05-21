import {
  computeCreditScore,
  SURVEY_QUESTIONS,
  toBureauBucket,
  toTier,
} from "@loan/credit-scoring";
import { CreditScoreRepository, SurveyRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const submitSurveySchema = z.object({
  customerId: z.string().uuid(),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

export async function scoringRoutes(app: FastifyInstance) {
  const survey = new SurveyRepository(app.prisma);
  const scores = new CreditScoreRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  /** The questionnaire structure. Frontend renders this dynamically. */
  app.get("/survey/questions", async () => SURVEY_QUESTIONS);

  /**
   * Submit a completed survey. Computes the score in the same call so the
   * customer sees their tier immediately. Behavioral factors (on-time
   * payments, defaults) are pulled from the loan history.
   */
  app.post("/survey/submit", async (req, reply) => {
    const parsed = submitSurveySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const { customerId, answers } = parsed.data;

    // Behavior signal from prior loans (default rate, on-time rate).
    const history = await scores.behaviorSignal(customerId);

    const result = computeCreditScore({ answers, behavior: history });

    const saved = await survey.saveResponse({
      customerId,
      answers,
      score: result.score,
      tier: result.tier,
      breakdown: result.breakdown,
      computedById: req.user.sub,
    });
    await scores.upsertLatest({
      customerId,
      score: result.score,
      tier: result.tier,
      breakdown: result.breakdown,
      sourceSurveyId: saved.id,
    });

    return reply.code(201).send({ ...result, surveyId: saved.id });
  });

  /** Latest computed score for a customer. */
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/score",
    async (req, reply) => {
      const s = await scores.latestForCustomer(req.params.customerId);
      if (!s)
        return reply
          .code(404)
          .send({ error: "NotFound", message: "No score yet" });
      return s;
    },
  );

  /** Convenience: tier mapping without persisting anything. */
  app.get<{ Querystring: { score: string } }>("/tier", async (req, reply) => {
    const n = Number(req.query.score);
    if (!Number.isFinite(n)) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: "score query required" });
    }
    return { score: n, tier: toTier(n), bucket: toBureauBucket(n) };
  });
}
