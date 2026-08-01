/**
 * Screening admin routes. Phase 2: tenant-scoped — `app.screening` is
 * a factory that builds a ScreeningRepository on top of the calling
 * tenant's Prisma client (and its AML watchlist).
 */
import type { ScreeningRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const overrideSchema = z.object({
  note: z.string().min(1).max(500),
});

const watchlistSchema = z.object({
  list: z.string().min(1).max(40),
  fullName: z.string().min(1).max(200),
  aliases: z.array(z.string().max(200)).max(20).optional(),
  reason: z.string().max(500).optional(),
});

declare module "fastify" {
  interface FastifyRequest {
    screeningCtx?: { repo: ScreeningRepository };
  }
}

export async function screeningRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
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
    read,
    async (req) =>
      req.screeningCtx!.repo.listForCustomer(req.params.customerId),
  );

  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/latest",
    read,
    async (req) =>
      req.screeningCtx!.repo.latestForCustomer(req.params.customerId),
  );

  app.post<{ Params: { customerId: string } }>(
    "/customers/:customerId/run",
    { preHandler: app.requirePermission("screening.run") },
    async (req) => req.screeningCtx!.repo.screen(req.params.customerId),
  );

  app.post<{ Params: { customerId: string } }>(
    "/customers/:customerId/override",
    { preHandler: app.requirePermission("screening.override") },
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

  app.get("/watchlist", read, async (req) =>
    req.screeningCtx!.repo.listWatchlist(),
  );

  app.post(
    "/watchlist",
    { preHandler: app.requirePermission("screening.watchlist") },
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
    { preHandler: app.requirePermission("screening.watchlist") },
    async (req) => req.screeningCtx!.repo.removeWatchlistEntry(req.params.id),
  );
}
