/**
 * Compliance reports — the audit requirements across modules.
 *
 *   GET /reports/:type?from=&to=&format=json|csv
 *
 * Phase 2: per-request service wiring via `req.reportsServices`.
 */

import { DorsiRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

declare module "fastify" {
  interface FastifyRequest {
    reportsServices?: { reports: ReportsService };
  }
}

export async function reportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.reportsServices = {
      reports: new ReportsService(prisma, new DorsiRepository(prisma)),
    };
  });

  const ctrl = new ReportsController();

  app.get<{ Params: { type: string } }>(
    "/:type",
    { preHandler: app.requirePermission("reports.read") },
    ctrl.generate,
  );
}
