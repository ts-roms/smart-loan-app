/**
 * Compliance reports — the audit requirements across modules.
 *
 *   GET /reports/:type?from=&to=&format=json|csv
 *
 * Phase 2: per-request service wiring via `req.reportsServices`.
 */

import {
  AuditLogRepository,
  CollectionsRepository,
  DorsiRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

declare module "fastify" {
  interface FastifyRequest {
    reportsServices?: { reports: ReportsService; audit: AuditLogRepository };
  }
}

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.reportsServices = {
      reports: new ReportsService(
        prisma,
        new DorsiRepository(prisma),
        new CollectionsRepository(prisma),
      ),
      // Built with the caller so an impersonated session stamps the
      // platform operator behind it — see AuditLogRepository.
      audit: new AuditLogRepository(prisma, req.user?.impersonatedBy),
    };
  });

  const ctrl = new ReportsController();

  app.get<{ Params: { type: string } }>(
    "/:type",
    { preHandler: app.requirePermission("reports.read") },
    ctrl.generate,
  );
}
