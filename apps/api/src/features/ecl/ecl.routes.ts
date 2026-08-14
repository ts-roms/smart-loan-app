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

import { routeSchema } from "../../lib/openapi";
import { EclController } from "./ecl.controller";
import { EclService } from "./ecl.service";
import {
  eclRunListResponseSchema,
  eclRunResultResponseSchema,
} from "./schemas";

const TAGS = ["ecl"];

declare module "fastify" {
  interface FastifyRequest {
    eclServices?: { ecl: EclService };
  }
}

export async function eclRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // ECL provisioning is an ENTERPRISE-tier feature. The gate reads the
  // caller's license via req.tenantCtx, so resolveTenant must run first.
  app.addHook("preHandler", app.requireFeature("accounting.ecl"));
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.eclServices = {
      ecl: new EclService(
        new EclRepository(prisma),
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
      ),
    };
  });

  const ctrl = new EclController();

  app.get(
    "/runs",
    {
      preHandler: app.requirePermission("accounting.read"),
      schema: routeSchema({
        summary:
          "ECL run history, newest period first, capped at 60. Money is " +
          "returned as exact decimal STRINGS — these are the stored " +
          "Decimal columns, unprojected.",
        tags: TAGS,
        permission: "accounting.read",
        response: eclRunListResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    ctrl.list,
  );

  /*
   * No `body` schema, deliberately, and this is the trap the previous
   * two batches measured rather than guessed.
   *
   * The controller parses `req.body ?? {}` and every field of
   * `runSchema` is optional, so `POST /ecl/runs` with no body at all is
   * a legal call that recomputes the current month. Attaching the body
   * schema would make Fastify reject that bodyless request with
   * `body must be object` — turning a working call into a 400 as a side
   * effect of documenting it. The response is described; the request
   * stays open because the handler genuinely accepts nothing.
   *
   * With no request schema on either route in this group there is also
   * nothing for Fastify to validate ahead of `preHandler`, which is why
   * `app.authenticate` can stay where it is above while every group
   * that DID gain a request schema had to move to `onRequest`.
   */
  app.post(
    "/runs",
    {
      preHandler: app.requirePermission("accounting.accrue"),
      schema: routeSchema({
        summary:
          "Recompute expected credit loss and post the provision delta. " +
          "Body is optional — omitted, it runs the current month. Money " +
          "here is a NUMBER, unlike the stored history above.",
        tags: TAGS,
        permission: "accounting.accrue",
        response: eclRunResultResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.run,
  );
}
