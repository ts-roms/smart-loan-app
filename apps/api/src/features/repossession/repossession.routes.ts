/**
 * Repossession API.
 *
 * Each state transition is its own endpoint, gated by a distinct
 * permission so the chain (BM → Credit Head → Legal) can be routed to
 * different roles via RBAC.
 *
 *   POST   /repossession              repossession.identify
 *   GET    /repossession              loans.read
 *   GET    /repossession/:id          loans.read
 *   GET    /repossession/:id/outstanding   loans.read
 *   POST   /repossession/:id/bm-approve         repossession.bm_approve
 *   POST   /repossession/:id/credit-approve     repossession.credit_approve
 *   POST   /repossession/:id/legal-approve      repossession.legal_approve
 *   POST   /repossession/:id/assign-agent       repossession.assign_agent
 *   POST   /repossession/:id/recover            repossession.recover
 *   POST   /repossession/:id/auction            repossession.auction
 *   POST   /repossession/:id/cancel             repossession.identify
 *
 * Layered: routes → controller → service → repo + audit + journal
 * (the auction transition posts a settlement entry).
 *
 * Phase 2: per-request service wiring via `req.repossessionServices`.
 */

import {
  AuditLogRepository,
  LoanRepository,
  RepossessionRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";

import { RepossessionController } from "./repossession.controller";
import { RepossessionService } from "./repossession.service";
import {
  approvalSchema,
  assignSchema,
  auctionResponseSchema,
  auctionSchema,
  cancelSchema,
  caseIdParamSchema,
  caseListResponseSchema,
  caseResponseSchema,
  listQuerySchema,
  openSchema,
  outstandingResponseSchema,
  recoverSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    repossessionServices?: { repossession: RepossessionService };
  }
}

const TAGS = ["repossession"];

export async function repossessionRoutes(app: FastifyInstance) {
  // onRequest, not preHandler — routes in this group carry request
  // schemas, and Fastify validates at preValidation, BEFORE preHandler.
  // With authenticate at preHandler an unauthenticated caller with a
  // malformed body got a 400 describing the schema instead of a 401.
  // See decision-rules.routes.ts for the full account.
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // Repossession workflow is a PROFESSIONAL-tier feature. The gate reads
  // req.tenantCtx, so resolveTenant must run before it.
  app.addHook("preHandler", app.requireFeature("servicing.repossession"));
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.repossessionServices = {
      repossession: new RepossessionService(
        prisma,
        new RepossessionRepository(prisma),
        new LoanRepository(prisma),
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
      ),
    };
  });

  const ctrl = new RepossessionController();

  app.get(
    "/",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "Repossession cases, newest first (up to 200), each carrying " +
          "its loan reference. Filter by ?status and/or ?loanId.",
        tags: TAGS,
        querystring: listQuerySchema,
        response: caseListResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.list,
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary: "One repossession case, whatever stage it is at.",
        tags: TAGS,
        params: caseIdParamSchema,
        response: caseResponseSchema,
        errors: [401, 402, 403, 404],
      }),
    },
    ctrl.findById,
  );

  app.get<{ Params: { id: string } }>(
    "/:id/outstanding",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "The loan's combined outstanding (schedule + accrued penalties) " +
          "— what the recover form default-fills.",
        tags: TAGS,
        params: caseIdParamSchema,
        response: outstandingResponseSchema,
        errors: [401, 402, 403, 404],
      }),
    },
    ctrl.outstanding,
  );

  app.post(
    "/",
    {
      preHandler: app.requirePermission("repossession.identify"),
      schema: routeSchema({
        summary:
          "Open a case against a loan (stage IDENTIFIED). One live case " +
          "per loan — a duplicate is refused as 400.",
        tags: TAGS,
        body: openSchema,
        response: caseResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.open,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/bm-approve",
    {
      preHandler: app.requirePermission("repossession.bm_approve"),
      schema: routeSchema({
        summary:
          "Branch Manager tick — IDENTIFIED → BM_APPROVED. 400 covers an " +
          "invalid transition or unknown case.",
        tags: TAGS,
        params: caseIdParamSchema,
        body: approvalSchema,
        response: caseResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.bmApprove,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/credit-approve",
    {
      preHandler: app.requirePermission("repossession.credit_approve"),
      schema: routeSchema({
        summary:
          "Credit Head tick — BM_APPROVED → CREDIT_HEAD_APPROVED. 400 " +
          "covers an invalid transition or unknown case.",
        tags: TAGS,
        params: caseIdParamSchema,
        body: approvalSchema,
        response: caseResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.creditApprove,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/legal-approve",
    {
      preHandler: app.requirePermission("repossession.legal_approve"),
      schema: routeSchema({
        summary:
          "Legal tick — CREDIT_HEAD_APPROVED → LEGAL_APPROVED. 400 " +
          "covers an invalid transition or unknown case.",
        tags: TAGS,
        params: caseIdParamSchema,
        body: approvalSchema,
        response: caseResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.legalApprove,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/assign-agent",
    {
      preHandler: app.requirePermission("repossession.assign_agent"),
      schema: routeSchema({
        summary:
          "Hand the recovery to a field agent — LEGAL_APPROVED → " +
          "AGENT_ASSIGNED.",
        tags: TAGS,
        params: caseIdParamSchema,
        body: assignSchema,
        response: caseResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.assignAgent,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/recover",
    {
      preHandler: app.requirePermission("repossession.recover"),
      schema: routeSchema({
        summary:
          "Record the vehicle recovered — AGENT_ASSIGNED → RECOVERED. " +
          "Captures condition, storage, and the outstanding at recovery.",
        tags: TAGS,
        params: caseIdParamSchema,
        body: recoverSchema,
        response: caseResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.recover,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/auction",
    {
      preHandler: app.requirePermission("repossession.auction"),
      schema: routeSchema({
        summary:
          "Auction the vehicle — RECOVERED → AUCTIONED. Posts the " +
          "settlement entry, closes the loan, and answers the " +
          "deficiency/surplus verdict.",
        tags: TAGS,
        params: caseIdParamSchema,
        body: auctionSchema,
        response: auctionResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.auction,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/cancel",
    {
      preHandler: app.requirePermission("repossession.identify"),
      schema: routeSchema({
        summary:
          "Cancel a case from any pre-terminal stage, keeping the reason " +
          "on file.",
        tags: TAGS,
        params: caseIdParamSchema,
        body: cancelSchema,
        response: caseResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.cancel,
  );
}
