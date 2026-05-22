/**
 * Credit-scoring endpoints — questionnaire + persisted scores.
 *
 *   GET  /scoring/survey/questions             any authenticated
 *   POST /scoring/survey/submit                any authenticated
 *   GET  /scoring/customers/:customerId/score  any authenticated
 *   GET  /scoring/tier?score=720               any authenticated
 *
 * Phase 2: per-request service wiring via `req.scoringServices`.
 * Repos + service tree are built fresh per request against the
 * tenant-scoped Prisma client.
 */

import { CreditScoreRepository, SurveyRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ScoringController } from "./scoring.controller";
import { ScoringService } from "./scoring.service";

declare module "fastify" {
  interface FastifyRequest {
    scoringServices?: { scoring: ScoringService };
  }
}

export async function scoringRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.scoringServices = {
      scoring: new ScoringService(
        new SurveyRepository(prisma),
        new CreditScoreRepository(prisma),
      ),
    };
  });

  const ctrl = new ScoringController();

  app.get("/survey/questions", ctrl.questions);
  app.post("/survey/submit", ctrl.submit);
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/score",
    ctrl.latestForCustomer,
  );
  app.get("/tier", ctrl.tier);
}
