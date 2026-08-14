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

import { routeSchema } from "../../lib/openapi";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";
import {
  auditActionsResponseSchema,
  auditListResponseSchema,
  listQuerySchema,
} from "./schemas";

const TAGS = ["audit"];

declare module "fastify" {
  interface FastifyRequest {
    auditServices?: { audit: AuditService };
  }
}

export async function auditRoutes(app: FastifyInstance) {
  /*
   * `onRequest` rather than `preHandler`, because `GET /` now carries a
   * querystring schema. Fastify validates between the two hooks, so at
   * `preHandler` an anonymous caller sending `?page=nonsense` would be
   * told their page number was wrong (400) rather than that they were
   * not logged in (401). `resolveTenant` stays where it is — it reads
   * the claim this hook verifies, and never rejects on shape.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.auditServices = { audit: new AuditService(req.tenantCtx.prisma) };
  });

  const ctrl = new AuditController();

  app.get(
    "/",
    {
      preHandler: app.requirePermission("admin.audit_log"),
      schema: routeSchema({
        summary:
          "The audit trail, newest first, filtered and paginated. The " +
          "actor is flattened onto each row; `payload` carries " +
          "action-specific detail whose shape varies by `action`.",
        tags: TAGS,
        permission: "admin.audit_log",
        querystring: listQuerySchema,
        response: auditListResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.list,
  );

  app.get(
    "/distinct/actions",
    {
      preHandler: app.requirePermission("admin.audit_log"),
      schema: routeSchema({
        summary:
          "Every action name present in the log, sorted — the filter " +
          "dropdown's source. Read from the table, so a new action " +
          "appears the first time it is recorded.",
        tags: TAGS,
        permission: "admin.audit_log",
        response: auditActionsResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listDistinctActions,
  );
}
