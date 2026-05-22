/**
 * Audit log read API. Append-only writes happen inline from the
 * feature services that perform privileged actions (via
 * `AuditLogRepository.record()`); this route only exposes the read
 * side.
 *
 *   GET /audit                       admin.audit_log
 *   GET /audit/distinct/actions      admin.audit_log
 *
 * Phase 2: per-request service wiring.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";

declare module "fastify" {
  interface FastifyRequest {
    auditServices?: { audit: AuditService };
  }
}

export async function auditRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.auditServices = { audit: new AuditService(req.tenantCtx.prisma) };
  });

  const ctrl = new AuditController();

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
