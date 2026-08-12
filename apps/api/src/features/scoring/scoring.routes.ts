/**
 * Credit-scoring endpoints — questionnaire + persisted scores.
 *
 *   GET  /scoring/survey/questions             customers.read
 *   POST /scoring/survey/submit                customers.write
 *   GET  /scoring/customers/:customerId/score  customers.read
 *   GET  /scoring/tier?score=720               any authenticated
 *
 *   GET    /scoring/catalog                    customers.read
 *   GET    /scoring/catalog/versions          scoring.read
 *   GET    /scoring/catalog/versions/:version scoring.read
 *   POST   /scoring/catalog/factors            admin.scoring_catalog
 *   PATCH  /scoring/catalog/factors/:id        admin.scoring_catalog
 *   DELETE /scoring/catalog/factors/:id        admin.scoring_catalog
 *   POST   /scoring/catalog/questions          admin.scoring_catalog
 *   PATCH  /scoring/catalog/questions/:id      admin.scoring_catalog
 *   DELETE /scoring/catalog/questions/:id      admin.scoring_catalog
 *   POST   /scoring/catalog/{factors,questions}/reorder
 *
 * The catalog defines the underwriting model itself, so writes take
 * their own admin key rather than customers.write: editing it changes
 * how every future borrower is scored, which is a different act from
 * scoring one borrower. Reading it rides on customers.read because the
 * survey page renders from it.
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

import {
  CreditScoreRepository,
  ScoringCatalogRepository,
  SurveyRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ScoringCatalogController } from "./catalog.controller";
import { ScoringController } from "./scoring.controller";
import { ScoringService } from "./scoring.service";

declare module "fastify" {
  interface FastifyRequest {
    scoringServices?: {
      scoring: ScoringService;
      catalog: ScoringCatalogRepository;
    };
  }
}

export async function scoringRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    const catalog = new ScoringCatalogRepository(prisma);
    req.scoringServices = {
      scoring: new ScoringService(
        new SurveyRepository(prisma),
        new CreditScoreRepository(prisma),
        catalog,
      ),
      catalog,
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

  // ─── catalog (admin-editable survey) ───────────────────────────────
  const cat = new ScoringCatalogController();
  const editCatalog = {
    preHandler: app.requirePermission("admin.scoring_catalog"),
  };

  app.get("/catalog", read, cat.list);
  /*
   * Reading the history is the same permission as reading the catalog,
   * not the admin one. An officer explaining a customer's score needs to
   * know which scorecard produced it — and, if it was not the current
   * one, what that scorecard said. Withholding that would leave them
   * explaining a number with the wrong weights.
   *
   * Registered before any "/catalog/:something" pattern so "versions"
   * is never mistaken for one.
   */
  app.get("/catalog/versions", read, cat.history);
  app.get<{ Params: { version: string } }>(
    "/catalog/versions/:version",
    read,
    cat.version,
  );
  app.post("/catalog/factors", editCatalog, cat.createFactor);
  app.post("/catalog/factors/reorder", editCatalog, cat.reorderFactors);
  app.patch<{ Params: { id: string } }>(
    "/catalog/factors/:id",
    editCatalog,
    cat.updateFactor,
  );
  app.delete<{ Params: { id: string } }>(
    "/catalog/factors/:id",
    editCatalog,
    cat.deleteFactor,
  );
  app.post("/catalog/questions", editCatalog, cat.createQuestion);
  app.post("/catalog/questions/reorder", editCatalog, cat.reorderQuestions);
  app.patch<{ Params: { id: string } }>(
    "/catalog/questions/:id",
    editCatalog,
    cat.updateQuestion,
  );
  app.delete<{ Params: { id: string } }>(
    "/catalog/questions/:id",
    editCatalog,
    cat.deleteQuestion,
  );
}
