/**
 * Credit-scoring endpoints — questionnaire + persisted scores.
 *
 *   GET  /scoring/survey/questions             customers.read
 *   POST /scoring/survey/submit                customers.write
 *   GET  /scoring/customers/:customerId/score  customers.read
 *   GET  /scoring/tier?score=720               any authenticated
 *
 * The scoring surface is officer tooling keyed by `customerId`, so it
 * inherits the customers keys rather than growing its own: reading a
 * borrower's credit score is a `customers.read` act, and submitting the
 * questionnaire persists a CreditScore row against a customer — a
 * decisioning input — so it takes `customers.write`. The questionnaire
 * structure itself is gated too; it's the shape of the underwriting
 * model and there's no borrower-facing surface that needs it.
 *
 * `GET /tier` is left open: it's a pure lookup of the tier band for a
 * score passed in the query string, touching no rows at all.
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

  const read = { preHandler: app.requirePermission("customers.read") };

  app.get("/survey/questions", read, ctrl.questions);
  app.post(
    "/survey/submit",
    { preHandler: app.requirePermission("customers.write") },
    ctrl.submit,
  );
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/score",
    read,
    ctrl.latestForCustomer,
  );
  app.get("/tier", ctrl.tier);
}
