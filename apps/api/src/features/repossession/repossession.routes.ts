/**
 * Repossession API — FRD §3.7.
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
 */

import {
  AuditLogRepository,
  LoanRepository,
  RepossessionRepository,
} from "@loan/db";
import type { FastifyInstance } from "fastify";

import { RepossessionController } from "./repossession.controller";
import { RepossessionService } from "./repossession.service";

export async function repossessionRoutes(app: FastifyInstance) {
  const service = new RepossessionService(
    app.prisma,
    new RepossessionRepository(app.prisma),
    new LoanRepository(app.prisma),
    new AuditLogRepository(app.prisma),
  );
  const ctrl = new RepossessionController(service);

  app.addHook("preHandler", app.authenticate);
  // Repossession workflow is a PROFESSIONAL-tier feature.
  app.addHook("preHandler", app.requireFeature("servicing.repossession"));

  app.get("/", { preHandler: app.requirePermission("loans.read") }, ctrl.list);

  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("loans.read") },
    ctrl.findById,
  );

  app.get<{ Params: { id: string } }>(
    "/:id/outstanding",
    { preHandler: app.requirePermission("loans.read") },
    ctrl.outstanding,
  );

  app.post(
    "/",
    { preHandler: app.requirePermission("repossession.identify") },
    ctrl.open,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/bm-approve",
    { preHandler: app.requirePermission("repossession.bm_approve") },
    ctrl.bmApprove,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/credit-approve",
    { preHandler: app.requirePermission("repossession.credit_approve") },
    ctrl.creditApprove,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/legal-approve",
    { preHandler: app.requirePermission("repossession.legal_approve") },
    ctrl.legalApprove,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/assign-agent",
    { preHandler: app.requirePermission("repossession.assign_agent") },
    ctrl.assignAgent,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/recover",
    { preHandler: app.requirePermission("repossession.recover") },
    ctrl.recover,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/auction",
    { preHandler: app.requirePermission("repossession.auction") },
    ctrl.auction,
  );

  app.post<{ Params: { id: string } }>(
    "/:id/cancel",
    { preHandler: app.requirePermission("repossession.identify") },
    ctrl.cancel,
  );
}
