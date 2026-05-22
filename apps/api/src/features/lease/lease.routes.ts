/**
 * Lease-to-Own API — FRD §3.5.
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
 */

import { AuditLogRepository, LeaseRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { LeaseController } from "./lease.controller.js";
import { LeaseService } from "./lease.service.js";

export async function leaseRoutes(app: FastifyInstance) {
  const service = new LeaseService(
    new LeaseRepository(app.prisma),
    new AuditLogRepository(app.prisma),
  );
  const ctrl = new LeaseController(service);

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.requirePermission("lease.read") }, ctrl.list);

  app.get<{ Params: { loanId: string } }>(
    "/:loanId",
    { preHandler: app.requirePermission("lease.read") },
    ctrl.findForLoan,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/buyout",
    { preHandler: app.requirePermission("lease.buyout") },
    ctrl.buyout,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/pull-out",
    { preHandler: app.requirePermission("lease.pull_out") },
    ctrl.pullOut,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/return",
    { preHandler: app.requirePermission("lease.close") },
    ctrl.returnUnit,
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/extend",
    { preHandler: app.requirePermission("lease.close") },
    ctrl.extend,
  );
}
