/**
 * Compliance routes — GDPR / PH Data Privacy Act §16 endpoints +
 * data-retention policy admin.
 *
 *   POST /compliance/customers/:id/export   admin.compliance
 *   POST /compliance/customers/:id/erase    admin.compliance
 *   GET  /compliance/retention-policy       admin.compliance
 *   PUT  /compliance/retention-policy       admin.compliance
 *   POST /compliance/retention-purge        admin.compliance  (manual)
 *
 * All gated on `admin.compliance` — a distinct permission so the
 * operator who answers DSARs doesn't need `admin.users` (and vice
 * versa).
 *
 * Phase 2: per-request service wiring via `req.complianceServices`.
 */

import { AuditLogRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";
import { RetentionService } from "./retention.service";

declare module "fastify" {
  interface FastifyRequest {
    complianceServices?: {
      compliance: ComplianceService;
      retention: RetentionService;
    };
  }
}

export async function complianceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    const audit = new AuditLogRepository(prisma, req.user?.impersonatedBy);
    req.complianceServices = {
      compliance: new ComplianceService(prisma, audit),
      retention: new RetentionService(prisma, audit),
    };
  });

  const ctrl = new ComplianceController();

  // ─── DSAR ─────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/customers/:id/export",
    { preHandler: app.requirePermission("admin.compliance") },
    ctrl.exportCustomer,
  );

  app.post<{ Params: { id: string } }>(
    "/customers/:id/erase",
    { preHandler: app.requirePermission("admin.compliance") },
    ctrl.eraseCustomer,
  );

  // ─── retention ────────────────────────────────────────────────────
  app.get(
    "/retention-policy",
    { preHandler: app.requirePermission("admin.compliance") },
    ctrl.getRetentionPolicy,
  );

  app.put(
    "/retention-policy",
    { preHandler: app.requirePermission("admin.compliance") },
    ctrl.updateRetentionPolicy,
  );

  app.post(
    "/retention-purge",
    { preHandler: app.requirePermission("admin.compliance") },
    ctrl.runRetentionPurge,
  );
}
