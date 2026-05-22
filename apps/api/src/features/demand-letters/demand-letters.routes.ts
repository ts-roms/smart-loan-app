/**
 * Demand Letter API — FRD §3.6.
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
 * rule in the service (FRD §3.6.5).
 */

import {
  AuditLogRepository,
  DemandLetterRepository,
  LoanRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { DemandLetterController } from "./demand-letters.controller.js";
import { DemandLetterService } from "./demand-letters.service.js";

export async function demandLetterRoutes(app: FastifyInstance) {
  const service = new DemandLetterService(
    app.prisma,
    new DemandLetterRepository(app.prisma),
    new LoanRepository(app.prisma),
    app.notifications,
    new AuditLogRepository(app.prisma),
    app.log,
  );
  const resolveCallerPerms = async (req: FastifyRequest) =>
    req.permissions ?? (await app.resolvePermissions(req.user.sub));
  const ctrl = new DemandLetterController(service, resolveCallerPerms);

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/candidates",
    { preHandler: app.requirePermission("collections.demand_letter") },
    ctrl.candidates,
  );

  app.get(
    "/",
    { preHandler: app.requirePermission("collections.read") },
    ctrl.list,
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("collections.read") },
    ctrl.findById,
  );

  app.post(
    "/batch",
    { preHandler: app.requirePermission("collections.demand_letter") },
    ctrl.batch,
  );

  // The preHandler accepts EITHER permission — the service then narrows
  // to the exact one required by the letter's stage (FRD §3.6.5).
  app.post<{ Params: { id: string } }>(
    "/:id/approve",
    {
      preHandler: app.requirePermission(
        "collections.dl_approve_company",
        "collections.dl_approve_legal",
      ),
    },
    ctrl.approve,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/dispatch",
    { preHandler: app.requirePermission("collections.dl_dispatch") },
    ctrl.dispatch,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/close",
    { preHandler: app.requirePermission("collections.demand_letter") },
    ctrl.close,
  );
}
