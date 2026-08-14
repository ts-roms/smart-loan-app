/**
 * Staff-facing pre-assessment — run the decisioning rules before an
 * application exists, and keep the answer.
 *
 *   POST /pre-assessments        pre_assessment.run
 *   GET  /pre-assessments        pre_assessment.read
 *   GET  /pre-assessments/:id    pre_assessment.read
 *
 * The subject may be an existing customer (full picture: score, AML, KYC)
 * or a walk-in prospect with no Customer row (indicative only). Borrowers
 * use POST /portal/pre-assessments, which forces the subject to their own
 * record.
 *
 * Why not `loans.apply`? A pre-assessment creates no application and can be
 * run for someone who isn't a customer, so the branch staff who quote
 * figures at the counter shouldn't need the key that submits loans. It
 * does echo back the rule that fired — internal underwriting policy — so
 * it isn't public either.
 *
 * Phase 2: per-request service wiring via req.preAssessmentServices.
 */

import {
  CreditScoreRepository,
  DecisionRuleRepository,
  KycRepository,
  PreAssessmentRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { PreAssessmentController } from "./pre-assessment.controller";
import { PreAssessmentService } from "./pre-assessment.service";
import {
  preAssessmentIdParamSchema,
  preAssessmentListResponseSchema,
  preAssessmentQuerySchema,
  preAssessmentResponseSchema,
  preAssessmentSchema,
} from "./schemas";

const TAGS = ["pre-assessment"];

declare module "fastify" {
  interface FastifyRequest {
    preAssessmentServices?: { preAssessments: PreAssessmentService };
  }
}

export async function preAssessmentRoutes(app: FastifyInstance) {
  /*
   * `onRequest`, because all three routes now carry request schemas and
   * Fastify validates between `onRequest` and `preHandler`. At
   * `preHandler` an anonymous POST with a bad body would answer 400
   * describing the underwriting terms — internal policy — to a caller
   * who never authenticated.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.preAssessmentServices = {
      preAssessments: new PreAssessmentService(
        {
          prisma,
          // Tenant-scoped factory — the AML provider closes over this
          // tenant's watchlist. See routes/index.ts.
          screening: app.screening(prisma),
          scores: new CreditScoreRepository(prisma),
          kyc: new KycRepository(prisma),
          rules: new DecisionRuleRepository(prisma),
        },
        new PreAssessmentRepository(prisma),
      ),
    };
  });

  const ctrl = new PreAssessmentController();

  app.post(
    "/",
    {
      preHandler: app.requirePermission("pre_assessment.run"),
      schema: routeSchema({
        summary:
          "Run the decisioning rules before an application exists, and " +
          "keep the answer. Subject is either a customer on file (FULL " +
          "basis) or a walk-in prospect (INDICATIVE). 404 names an " +
          "unknown `customerId`.",
        tags: TAGS,
        body: preAssessmentSchema,
        response: preAssessmentResponseSchema,
        status: 201,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.run,
  );
  app.get(
    "/",
    {
      preHandler: app.requirePermission("pre_assessment.read"),
      schema: routeSchema({
        summary:
          "Recent pre-assessments, newest first. Every filter is " +
          "optional; the default is the 50 most recent.",
        tags: TAGS,
        querystring: preAssessmentQuerySchema,
        response: preAssessmentListResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.list,
  );
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("pre_assessment.read"),
      schema: routeSchema({
        summary:
          'One pre-assessment, by uuid or by its "PA-…" number, with ' +
          "the customer joined in.",
        tags: TAGS,
        params: preAssessmentIdParamSchema,
        response: preAssessmentResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.get,
  );
}
