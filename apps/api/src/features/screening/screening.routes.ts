/**
 * Screening admin routes. Phase 2: tenant-scoped — `app.screening` is
 * a factory that builds a ScreeningRepository on top of the calling
 * tenant's Prisma client (and its AML watchlist).
 */
import type { ScreeningRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";

import {
  customerIdParamSchema,
  overrideSchema,
  screeningListResponseSchema,
  screeningResponseSchema,
  watchlistIdParamSchema,
  watchlistListResponseSchema,
  watchlistEntryResponseSchema,
  watchlistSchema,
} from "./schemas";

const TAGS = ["screening"];

declare module "fastify" {
  interface FastifyRequest {
    screeningCtx?: { repo: ScreeningRepository };
  }
}

export async function screeningRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler — routes in this group carry request
   * schemas, and Fastify validates at preValidation, BEFORE preHandler.
   * With `authenticate` at preHandler an unauthenticated caller posting
   * a malformed watchlist row got a 400 describing the schema instead
   * of a 401. See decision-rules.routes.ts for the full account.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.screeningCtx = {
      repo: app.screening(req.tenantCtx.prisma),
    };
  });

  // AML screening results name the customer and the list they matched
  // against — sanctions/PEP hits are among the most sensitive rows in
  // the schema. `screening.read` (LOAN_OFFICER + ADMIN) on every read;
  // run / override / watchlist keep their own narrower keys below.
  const read = { preHandler: app.requirePermission("screening.read") };

  // ─── Per-customer screening ────────────────────────────────────

  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId",
    {
      ...read,
      schema: routeSchema({
        summary:
          "Every screen run against one customer, newest first — the " +
          "full AML history including overrides.",
        tags: TAGS,
        permission: "screening.read",
        params: customerIdParamSchema,
        response: screeningListResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) =>
      req.screeningCtx!.repo.listForCustomer(req.params.customerId),
  );

  /*
   * DELIBERATELY UNDOCUMENTED — the one route in this feature without a
   * response schema, and the reason is the payload, not the effort.
   *
   * A customer who has never been screened has no rows, and this
   * answers `null` at the TOP LEVEL rather than an object or a 404.
   * `routeSchema` would document an object there, so the spec would
   * describe a body this route genuinely does not always send — the
   * same call already made for the dorsi board-approval lookup, and for
   * the same reason. Documenting it honestly needs a nullable
   * top-level, which the helper has no way to express today.
   *
   * Counted as such: screening is 6 of 7 in the coverage breakdown.
   */
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/latest",
    read,
    async (req) =>
      req.screeningCtx!.repo.latestForCustomer(req.params.customerId),
  );

  app.post<{ Params: { customerId: string } }>(
    "/customers/:customerId/run",
    {
      preHandler: app.requirePermission("screening.run"),
      schema: routeSchema({
        summary:
          "Screen a customer against the watchlists now, appending a new " +
          "row. The answer is that row, and it becomes their status.",
        tags: TAGS,
        permission: "screening.run",
        params: customerIdParamSchema,
        response: screeningResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) => req.screeningCtx!.repo.screen(req.params.customerId),
  );

  app.post<{ Params: { customerId: string } }>(
    "/customers/:customerId/override",
    {
      preHandler: app.requirePermission("screening.override"),
      schema: routeSchema({
        summary:
          "Clear a customer despite a match, with a justification. " +
          "Recorded as a new OVERRIDDEN row, not an edit of the old one.",
        tags: TAGS,
        permission: "screening.override",
        params: customerIdParamSchema,
        body: overrideSchema,
        response: screeningResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const parsed = overrideSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return req.screeningCtx!.repo.override(
        req.params.customerId,
        parsed.data.note,
        req.user.sub,
      );
    },
  );

  // ─── Watchlist (mock provider's data source) ───────────────────

  app.get(
    "/watchlist",
    {
      ...read,
      schema: routeSchema({
        summary:
          "The whole watchlist the mock provider screens against, " +
          "alphabetical by name.",
        tags: TAGS,
        permission: "screening.read",
        response: watchlistListResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) => req.screeningCtx!.repo.listWatchlist(),
  );

  app.post(
    "/watchlist",
    {
      preHandler: app.requirePermission("screening.watchlist"),
      schema: routeSchema({
        summary: "Add a name to the watchlist.",
        tags: TAGS,
        permission: "screening.watchlist",
        body: watchlistSchema,
        response: watchlistEntryResponseSchema,
        status: 201,
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const parsed = watchlistSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return reply
        .code(201)
        .send(await req.screeningCtx!.repo.addWatchlistEntry(parsed.data));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/watchlist/:id",
    {
      preHandler: app.requirePermission("screening.watchlist"),
      schema: routeSchema({
        summary:
          "Remove a name from the watchlist. Answers the deleted row, " +
          "not a 204.",
        tags: TAGS,
        permission: "screening.watchlist",
        params: watchlistIdParamSchema,
        response: watchlistEntryResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) => req.screeningCtx!.repo.removeWatchlistEntry(req.params.id),
  );
}
