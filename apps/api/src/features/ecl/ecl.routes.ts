/**
 * IFRS 9 / PFRS 9 expected-credit-loss endpoints.
 *
 *   GET  /ecl/runs              accounting.read     — history (last 60)
 *   POST /ecl/runs              accounting.accrue   — recompute
 *
 * Phase 2: per-request service wiring via `req.eclServices`.
 */

import { AuditLogRepository, EclRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { EclController } from "./ecl.controller";
import { EclService } from "./ecl.service";

declare module "fastify" {
  interface FastifyRequest {
    eclServices?: { ecl: EclService };
  }
}

export async function eclRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  // ECL provisioning is an ENTERPRISE-tier feature.
  app.addHook("preHandler", app.requireFeature("accounting.ecl"));
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.eclServices = {
      ecl: new EclService(
        new EclRepository(prisma),
        new AuditLogRepository(prisma),
      ),
    };
  });

  const ctrl = new EclController();

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
