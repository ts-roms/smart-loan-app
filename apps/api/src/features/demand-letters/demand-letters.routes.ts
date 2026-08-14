/**
 * Demand Letter API.
 *
 *   GET    /demand-letters/candidates?stage=FIRST  collections.demand_letter
 *   GET    /demand-letters?stage=&status=          collections.read
 *   GET    /demand-letters/:id                     collections.read
 *   POST   /demand-letters/batch                   collections.demand_letter
 *   POST   /demand-letters/:id/approve             collections.dl_approve_company | collections.dl_approve_legal
 *   POST   /demand-letters/:id/dispatch            collections.dl_dispatch
 *   POST   /demand-letters/:id/close               collections.demand_letter
 *
 * Layered: routes → controller → service → repo + audit + notifications.
 * Approval has a stage-gated permission check + segregation-of-duties
 * rule in the service.
 *
 * Phase 2: per-request service wiring via `req.demandLetterServices`.
 */

import {
  AuditLogRepository,
  DemandLetterRepository,
  LoanRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";

import { DemandLetterController } from "./demand-letters.controller";
import { DemandLetterService } from "./demand-letters.service";
import {
  approveSchema,
  batchResponseSchema,
  batchSchema,
  candidateListResponseSchema,
  candidatesQuerySchema,
  closeSchema,
  dispatchSchema,
  letterIdParamSchema,
  letterListResponseSchema,
  letterResponseSchema,
  listQuerySchema,
} from "./schemas";

const TAGS = ["demand-letters"];

declare module "fastify" {
  interface FastifyRequest {
    demandLetterServices?: {
      demandLetters: DemandLetterService;
      resolveCallerPerms: (userId: string) => Promise<Set<string>>;
    };
  }
}

export async function demandLetterRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler — routes in this group carry request
   * schemas, and Fastify validates at preValidation, BEFORE preHandler.
   * With `authenticate` at preHandler an unauthenticated caller posting
   * a malformed batch got a 400 describing the schema instead of a 401.
   * See decision-rules.routes.ts for the full account.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // Demand letters are a PROFESSIONAL-tier feature. The gate reads
  // req.tenantCtx, so resolveTenant must run before it.
  app.addHook("preHandler", app.requireFeature("servicing.demand_letters"));
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.demandLetterServices = {
      demandLetters: new DemandLetterService(
        prisma,
        new DemandLetterRepository(prisma),
        new LoanRepository(prisma),
        app.notifications(prisma),
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
        app.log,
      ),
      resolveCallerPerms: (userId: string) =>
        app.resolvePermissions(userId, prisma),
    };
  });

  const ctrl = new DemandLetterController();

  app.get(
    "/candidates",
    {
      preHandler: app.requirePermission("collections.demand_letter"),
      schema: routeSchema({
        summary:
          "Loans eligible for a letter at ?stage — overdue past that " +
          "stage's threshold with no active letter already at it.",
        tags: TAGS,
        permission: "collections.demand_letter",
        querystring: candidatesQuerySchema,
        response: candidateListResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.candidates,
  );

  app.get(
    "/",
    {
      preHandler: app.requirePermission("collections.read"),
      schema: routeSchema({
        summary:
          "Demand letters, newest first (up to 200), each with its loan " +
          "reference. Filter by ?stage, ?status and/or ?loanId.",
        tags: TAGS,
        permission: "collections.read",
        querystring: listQuerySchema,
        response: letterListResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.list,
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("collections.read"),
      schema: routeSchema({
        summary:
          "One demand letter, including the rendered body that was " +
          "captured at draft time.",
        tags: TAGS,
        permission: "collections.read",
        params: letterIdParamSchema,
        response: letterResponseSchema,
        errors: [401, 402, 403, 404],
      }),
    },
    ctrl.findById,
  );

  app.post(
    "/batch",
    {
      preHandler: app.requirePermission("collections.demand_letter"),
      schema: routeSchema({
        summary:
          "Draft letters for a set of loans at one stage. Loans that " +
          "stopped qualifying since /candidates are skipped silently.",
        tags: TAGS,
        permission: "collections.demand_letter",
        body: batchSchema,
        response: batchResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.batch,
  );

  // The preHandler accepts EITHER permission — the service then narrows
  // to the exact one required by the letter's stage.
  app.post<{ Params: { id: string } }>(
    "/:id/approve",
    {
      preHandler: app.requirePermission(
        "collections.dl_approve_company",
        "collections.dl_approve_legal",
      ),
      schema: routeSchema({
        summary:
          "Approve a drafted letter. 403 if the stage needs the other " +
          "signatory, or if you are the drafter (segregation of duties).",
        tags: TAGS,
        permission: [
          "collections.dl_approve_company",
          "collections.dl_approve_legal",
        ],
        params: letterIdParamSchema,
        body: approveSchema,
        response: letterResponseSchema,
        errors: [400, 401, 402, 403, 404],
      }),
    },
    ctrl.approve,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/dispatch",
    {
      preHandler: app.requirePermission("collections.dl_dispatch"),
      schema: routeSchema({
        summary:
          "Send an approved letter and record the channel it went by. " +
          "Fires the borrower notification.",
        tags: TAGS,
        permission: "collections.dl_dispatch",
        params: letterIdParamSchema,
        body: dispatchSchema,
        response: letterResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.dispatch,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/close",
    {
      preHandler: app.requirePermission("collections.demand_letter"),
      schema: routeSchema({
        summary:
          "Close a letter as RESPONDED (the borrower paid or engaged) or " +
          "WAIVED (collections chose not to pursue it).",
        tags: TAGS,
        permission: "collections.demand_letter",
        params: letterIdParamSchema,
        body: closeSchema,
        response: letterResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.close,
  );
}
