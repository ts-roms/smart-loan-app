import { AuditLogRepository, DorsiRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { DorsiController } from "./dorsi.controller";
import { registerDorsiHttp } from "./dorsi.routes";
import { DorsiService } from "./dorsi.service";

declare module "fastify" {
  interface FastifyRequest {
    dorsiServices?: { dorsi: DorsiService };
  }
}

/**
 * DORSI feature entry point — registered under the `/dorsi` prefix.
 *
 * Phase 2: per-request service wiring via `req.dorsiServices`. Every
 * state-changing action audits via the tenant-scoped AuditLogRepository.
 */
export async function dorsiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.authenticate);
  // DORSI is an ENTERPRISE-tier compliance module. Gate the entire
  // /dorsi/* prefix.
  app.addHook("preHandler", app.requireFeature("compliance.dorsi"));
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.dorsiServices = {
      dorsi: new DorsiService(
        new DorsiRepository(prisma),
        new AuditLogRepository(prisma),
      ),
    };
  });

  const controller = new DorsiController();
  registerDorsiHttp(app, controller);
}
