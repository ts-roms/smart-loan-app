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

import { routeSchema } from "../../lib/openapi";
import { ScoringCatalogController } from "./catalog.controller";
import {
  catalogHistoryResponseSchema,
  catalogIdParamSchema,
  catalogResponseSchema,
  catalogVersionResponseSchema,
  factorCreateSchema,
  factorRowResponseSchema,
  factorUpdateSchema,
  questionCreateSchema,
  questionRowResponseSchema,
  questionUpdateSchema,
  reorderSchema,
  versionParamSchema,
} from "./catalog.schemas";
import { ScoringController } from "./scoring.controller";
import {
  creditScoreResponseSchema,
  customerIdParamSchema,
  submitSurveySchema,
  submitSurveyResponseSchema,
  surveyQuestionListResponseSchema,
  tierQuerySchema,
  tierResponseSchema,
} from "./schemas";
import { ScoringService } from "./scoring.service";

const TAGS = ["scoring"];

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

  app.get(
    "/survey/questions",
    {
      ...read,
      schema: routeSchema({
        summary: "The questionnaire, in the order it should be asked.",
        tags: TAGS,
        response: surveyQuestionListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.questions,
  );
  app.post(
    "/survey/submit",
    {
      preHandler: app.requirePermission("customers.write"),
      schema: routeSchema({
        summary:
          "Score a completed questionnaire and persist it against the " +
          "customer.",
        tags: TAGS,
        body: submitSurveySchema,
        response: submitSurveyResponseSchema,
        status: 201,
        errors: [400, 401, 403],
      }),
    },
    ctrl.submit,
  );
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/score",
    {
      ...read,
      schema: routeSchema({
        summary: "The customer's most recent persisted score.",
        tags: TAGS,
        params: customerIdParamSchema,
        response: creditScoreResponseSchema,
        // 404 means never scored, not "no such customer".
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.latestForCustomer,
  );
  /*
   * Left open to any authenticated caller: a pure band lookup on a score
   * passed in the query string, touching no rows at all. Hence no 403.
   */
  app.get(
    "/tier",
    {
      schema: routeSchema({
        summary: "Band a score into its A-F tier and bureau bucket.",
        tags: TAGS,
        querystring: tierQuerySchema,
        response: tierResponseSchema,
        errors: [400, 401],
      }),
    },
    ctrl.tier,
  );

  // ─── catalog (admin-editable survey) ───────────────────────────────
  const cat = new ScoringCatalogController();
  const editCatalog = {
    preHandler: app.requirePermission("admin.scoring_catalog"),
  };

  app.get(
    "/catalog",
    {
      ...read,
      schema: routeSchema({
        summary:
          "The editable scorecard: factors, their questions, and what each " +
          "weight is currently worth in points.",
        tags: TAGS,
        response: catalogResponseSchema,
        errors: [401, 403],
      }),
    },
    cat.list,
  );
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
  app.get(
    "/catalog/versions",
    {
      ...read,
      schema: routeSchema({
        summary:
          "Every scorecard revision, newest first. Snapshots omitted — " +
          "fetch one version to get its snapshot.",
        tags: TAGS,
        response: catalogHistoryResponseSchema,
        errors: [401, 403],
      }),
    },
    cat.history,
  );
  app.get<{ Params: { version: string } }>(
    "/catalog/versions/:version",
    {
      ...read,
      schema: routeSchema({
        summary: "One revision, snapshot included — the replayable payload.",
        tags: TAGS,
        params: versionParamSchema,
        response: catalogVersionResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    cat.version,
  );
  app.post(
    "/catalog/factors",
    {
      ...editCatalog,
      schema: routeSchema({
        summary: "Add a factor. Redistributes every other factor's points.",
        tags: TAGS,
        body: factorCreateSchema,
        response: factorRowResponseSchema,
        status: 201,
        // 409 is a duplicate `key` — the request was well-formed and
        // permitted, and the catalog's state refuses it.
        errors: [400, 401, 403, 409],
      }),
    },
    cat.createFactor,
  );
  app.post(
    "/catalog/factors/reorder",
    {
      ...editCatalog,
      schema: routeSchema({
        summary: "Persist a new factor order. Mints a version; moves no points.",
        tags: TAGS,
        body: reorderSchema,
        errors: [400, 401, 403],
      }),
    },
    cat.reorderFactors,
  );
  app.patch<{ Params: { id: string } }>(
    "/catalog/factors/:id",
    {
      ...editCatalog,
      schema: routeSchema({
        summary:
          "Edit a factor. A weight change restates every other factor's " +
          "points.",
        tags: TAGS,
        params: catalogIdParamSchema,
        body: factorUpdateSchema,
        response: factorRowResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    cat.updateFactor,
  );
  app.delete<{ Params: { id: string } }>(
    "/catalog/factors/:id",
    {
      ...editCatalog,
      schema: routeSchema({
        summary: "Remove a factor. Refused while it still owns questions.",
        tags: TAGS,
        params: catalogIdParamSchema,
        // 409 carries `questionCount`: the FK cascades, so deleting a
        // factor would silently take its questions and every answer key
        // they own with it. Move them first.
        errors: [400, 401, 403, 409],
      }),
    },
    cat.deleteFactor,
  );
  app.post(
    "/catalog/questions",
    {
      ...editCatalog,
      schema: routeSchema({
        summary: "Add a question to a factor.",
        tags: TAGS,
        body: questionCreateSchema,
        response: questionRowResponseSchema,
        status: 201,
        errors: [400, 401, 403, 409],
      }),
    },
    cat.createQuestion,
  );
  app.post(
    "/catalog/questions/reorder",
    {
      ...editCatalog,
      schema: routeSchema({
        summary:
          "Persist a new question order. Versioned because the order is " +
          "what the borrower was asked in.",
        tags: TAGS,
        body: reorderSchema,
        errors: [400, 401, 403],
      }),
    },
    cat.reorderQuestions,
  );
  app.patch<{ Params: { id: string } }>(
    "/catalog/questions/:id",
    {
      ...editCatalog,
      schema: routeSchema({
        summary:
          "Edit a question. kind and config are validated as the MERGED " +
          "pair, not just the fields sent.",
        tags: TAGS,
        params: catalogIdParamSchema,
        body: questionUpdateSchema,
        response: questionRowResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    cat.updateQuestion,
  );
  app.delete<{ Params: { id: string } }>(
    "/catalog/questions/:id",
    {
      ...editCatalog,
      schema: routeSchema({
        summary: "Remove a question. Stored answers under its key survive.",
        tags: TAGS,
        params: catalogIdParamSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    cat.deleteQuestion,
  );
}
