/**
 * Credit-scoring endpoints — questionnaire + persisted scores.
 *
 *   GET  /scoring/survey/questions             any authenticated
 *   POST /scoring/survey/submit                any authenticated
 *   GET  /scoring/customers/:customerId/score  any authenticated
 *   GET  /scoring/tier?score=720               any authenticated
 *
 * Layered: routes → controller → service. The submit path pulls the
 * behavior signal from loan history, runs `computeCreditScore`, and
 * persists both the raw survey response + the rolled-up "latest
 * score" row in a single call so the customer sees their tier
 * immediately.
 */

import { CreditScoreRepository, SurveyRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { ScoringController } from "./scoring.controller";
import { ScoringService } from "./scoring.service";

export async function scoringRoutes(app: FastifyInstance) {
  const ctrl = new ScoringController(
    new ScoringService(
      new SurveyRepository(app.prisma),
      new CreditScoreRepository(app.prisma),
    ),
  );

  app.addHook("preHandler", app.authenticate);

  app.get("/survey/questions", ctrl.questions);
  app.post("/survey/submit", ctrl.submit);
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/score",
    ctrl.latestForCustomer,
  );
  app.get("/tier", ctrl.tier);
}
