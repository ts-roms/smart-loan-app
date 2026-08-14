/**
 * Lease-to-Own API.
 *
 *   GET    /lease                       lease.read
 *   GET    /lease/:loanId               lease.read
 *   POST   /lease/:loanId/buyout        lease.buyout
 *   POST   /lease/:loanId/pull-out      lease.pull_out
 *   POST   /lease/:loanId/return        lease.close
 *   POST   /lease/:loanId/extend        lease.close
 *
 * Agreements are created automatically by LoanRepository.disburse when
 * the product has `isLease=true`, so there is no POST /lease creation
 * endpoint.
 *
 * Layered: routes → controller → service → repo + audit. The service
 * couples each state transition to an audit-log record on success.
 *
 * Phase 2: per-request service wiring via `req.leaseServices`.
 */

import { LeaseRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";

import { LeaseController } from "./lease.controller";
import { LeaseService } from "./lease.service";
import {
  agreementListResponseSchema,
  agreementResponseSchema,
  buyoutResponseSchema,
  buyoutSchema,
  closeSchema,
  listQuerySchema,
  loanIdParamSchema,
  pullOutSchema,
} from "./schemas";
import { auditFor } from "../../lib/audit-context";

const TAGS = ["lease"];

declare module "fastify" {
  interface FastifyRequest {
    leaseServices?: { lease: LeaseService };
  }
}

export async function leaseRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler — routes in this group carry request
   * schemas, and Fastify validates at preValidation, BEFORE preHandler.
   * With `authenticate` at preHandler an unauthenticated caller posting
   * a malformed buyout got a 400 describing the schema instead of a
   * 401. See decision-rules.routes.ts for the full account.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // Lease-to-Own is a PROFESSIONAL-tier feature. The gate reads
  // req.tenantCtx, so resolveTenant must run before it.
  app.addHook("preHandler", app.requireFeature("servicing.lease"));
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.leaseServices = {
      lease: new LeaseService(
        new LeaseRepository(prisma),
        auditFor(req, prisma),
      ),
    };
  });

  const ctrl = new LeaseController();

  app.get(
    "/",
    {
      preHandler: app.requirePermission("lease.read"),
      schema: routeSchema({
        summary:
          "Lease agreements, newest first (up to 200), each with its loan " +
          "reference. Filter by ?status.",
        tags: TAGS,
        permission: "lease.read",
        querystring: listQuerySchema,
        response: agreementListResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.list,
  );

  app.get<{ Params: { loanId: string } }>(
    "/:loanId",
    {
      preHandler: app.requirePermission("lease.read"),
      schema: routeSchema({
        summary:
          "The lease agreement for one loan. 404 when the loan has none " +
          "— only lease products get an agreement at disbursement.",
        tags: TAGS,
        permission: "lease.read",
        params: loanIdParamSchema,
        response: agreementResponseSchema,
        errors: [401, 402, 403, 404],
      }),
    },
    ctrl.findForLoan,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/buyout",
    {
      preHandler: app.requirePermission("lease.buyout"),
      schema: routeSchema({
        summary:
          "Borrower pays the residual and takes title. Posts the buyout " +
          "journal entry and closes the loan; answers 201 with its id.",
        tags: TAGS,
        permission: "lease.buyout",
        params: loanIdParamSchema,
        body: buyoutSchema,
        response: buyoutResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.buyout,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/pull-out",
    {
      preHandler: app.requirePermission("lease.pull_out"),
      schema: routeSchema({
        summary:
          "Repossess the unit. Refused for an employee borrower — the " +
          "pull-out path is non-employee only.",
        tags: TAGS,
        permission: "lease.pull_out",
        params: loanIdParamSchema,
        body: pullOutSchema,
        response: agreementResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.pullOut,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/return",
    {
      preHandler: app.requirePermission("lease.close"),
      schema: routeSchema({
        summary:
          "Close the agreement as RETURNED — the borrower gave the unit " +
          "back rather than buying it out.",
        tags: TAGS,
        permission: "lease.close",
        params: loanIdParamSchema,
        body: closeSchema,
        response: agreementResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.returnUnit,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/extend",
    {
      preHandler: app.requirePermission("lease.close"),
      schema: routeSchema({
        summary:
          "Close the agreement as EXTENDED — the term was rolled forward " +
          "rather than settled.",
        tags: TAGS,
        permission: "lease.close",
        params: loanIdParamSchema,
        body: closeSchema,
        response: agreementResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.extend,
  );
}
