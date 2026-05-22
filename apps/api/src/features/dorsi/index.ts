import { AuditLogRepository, DorsiRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { DorsiController } from "./dorsi.controller";
import { registerDorsiHttp } from "./dorsi.routes";
import { DorsiService } from "./dorsi.service";

/**
 * DORSI feature entry point — registered under the `/dorsi` prefix.
 * Wires Prisma repositories → service → controller → routes. The
 * service depends on AuditLogRepository so every state-changing
 * action lands in the audit trail.
 */
export async function dorsiRoutes(app: FastifyInstance): Promise<void> {
  const repo = new DorsiRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);
  const service = new DorsiService(repo, audit);
  const controller = new DorsiController(service);

  app.addHook("preHandler", app.authenticate);
  // DORSI is an ENTERPRISE-tier compliance module. Gate the entire
  // /dorsi/* prefix.
  app.addHook("preHandler", app.requireFeature("compliance.dorsi"));

  registerDorsiHttp(app, controller);
}
