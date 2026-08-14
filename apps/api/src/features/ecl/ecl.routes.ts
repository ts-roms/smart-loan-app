/**
 * IFRS 9 / PFRS 9 expected-credit-loss endpoints.
 *
 *   GET  /ecl/runs              accounting.read     — history (last 60)
 *   POST /ecl/runs              accounting.accrue   — recompute
 *
 * Phase 2: per-request service wiring via `req.eclServices`.
 */

import { EclRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { EclController } from "./ecl.controller";
import { EclService } from "./ecl.service";
import {
  eclRunListResponseSchema,
  eclRunResultResponseSchema,
} from "./schemas";
import { auditFor } from "../../lib/audit-context";

const TAGS = ["ecl"];

declare module "fastify" {
  interface FastifyRequest {
    eclServices?: { ecl: EclService };
  }
}

export async function eclRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler.
   *
   * Fastify's order is onRequest -> parsing -> preValidation ->
   * preHandler. Neither route here carries a request schema (see the
   * note on POST /runs below), which is why this hook was left at
   * preHandler when every other group moved — the reasoning being that
   * with nothing to validate there was nothing to leak.
   *
   * That reasoning was half right and the missing half is the BODY
   * PARSER, which also runs ahead of preHandler. Measured before the
   * fix, with no Authorization header:
   *
   *   POST /ecl/runs  Content-Type: application/json  body: {"junk":[[[}
   *   -> 400 {"error":"Bad Request"}
   *
   * An anonymous caller got the JSON parser's verdict on their body
   * instead of a 401. It leaks less than a schema does — it says the
   * body was unparseable, not what a good one looks like — but it is
   * the same inversion, and a route in this group gaining a `body`
   * schema later would turn it into the full version. onRequest is
   * ahead of parsing, so the 401 wins in both cases.
   *
   * `jwtVerify` reads the Authorization header only, so it is safe this
   * early. `resolveTenant` and `requireFeature` need `req.user` and
   * `req.tenantCtx` respectively and stay at preHandler, in order.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // ECL provisioning is an ENTERPRISE-tier feature. The gate reads the
  // caller's license via req.tenantCtx, so resolveTenant must run first.
  app.addHook("preHandler", app.requireFeature("accounting.ecl"));
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.eclServices = {
      ecl: new EclService(new EclRepository(prisma), auditFor(req, prisma)),
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
   * There is therefore no request schema on either route in this group.
   * That once read as a reason `app.authenticate` could stay at
   * preHandler here while every group that DID gain a request schema
   * moved to `onRequest` — but a schema is not the only thing that runs
   * ahead of preHandler. The body parser does too, and it was answering
   * anonymous callers 400 on unparseable JSON; the hook has moved. See
   * the note above it.
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
