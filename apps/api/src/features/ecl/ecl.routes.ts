/**
 * IFRS 9 / PFRS 9 expected-credit-loss endpoints.
 *
 *   GET  /ecl/runs              accounting.read     — history (last 60)
 *   POST /ecl/runs              accounting.accrue   — recompute
 *
 * Recomputation is gated on `accounting.accrue` since it touches the
 * portfolio's provision state. The journal posting (DR Impairment
 * Expense, CR Allowance for Loan Losses) happens inside the repo's
 * `run` method.
 *
 * Layered: routes → controller → service → repo + audit.
 */

import { AuditLogRepository, EclRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { EclController } from "./ecl.controller.js";
import { EclService } from "./ecl.service.js";

export async function eclRoutes(app: FastifyInstance) {
  const ctrl = new EclController(
    new EclService(
      new EclRepository(app.prisma),
      new AuditLogRepository(app.prisma),
    ),
  );
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/runs",
    { preHandler: app.requirePermission("accounting.read") },
    ctrl.list,
  );

  app.post(
    "/runs",
    { preHandler: app.requirePermission("accounting.accrue") },
    ctrl.run,
  );
}
