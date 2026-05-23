/**
 * Compliance routes — GDPR / PH Data Privacy Act §16 endpoints.
 *
 *   POST /compliance/customers/:id/export   admin.compliance
 *   POST /compliance/customers/:id/erase    admin.compliance
 *
 * Both endpoints are PLATFORM_ADMIN-grade actions on the tenant side
 * — `admin.compliance` is a distinct permission so the operator who
 * answers DSARs doesn't need `admin.users` (and vice versa).
 *
 * Phase 2: per-request service wiring via `req.complianceServices`.
 */

import { AuditLogRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";

declare module "fastify" {
  interface FastifyRequest {
    complianceServices?: { compliance: ComplianceService };
  }
}

export async function complianceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.complianceServices = {
      compliance: new ComplianceService(
        prisma,
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
      ),
    };
  });

  const ctrl = new ComplianceController();

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
}
