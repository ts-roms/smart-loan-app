/**
 * Audit log read API. Append-only writes happen inline from the
 * feature services that perform privileged actions (via
 * `AuditLogRepository.record()`); this route only exposes the read
 * side.
 *
 *   GET /audit                       admin.audit_log
 *   GET /audit/distinct/actions      admin.audit_log
 *
 * Layered: routes → controller → service. The service flattens the
 * Prisma actor join into the row shape the audit drawer expects.
 */

import type { FastifyInstance } from "fastify";

import { AuditController } from "./audit.controller.js";
import { AuditService } from "./audit.service.js";

export async function auditRoutes(app: FastifyInstance) {
  const ctrl = new AuditController(new AuditService(app.prisma));

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    { preHandler: app.requirePermission("admin.audit_log") },
    ctrl.list,
  );

  app.get(
    "/distinct/actions",
    { preHandler: app.requirePermission("admin.audit_log") },
    ctrl.listDistinctActions,
  );
}
