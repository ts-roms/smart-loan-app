import { ScreeningRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";
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

export function screeningRoutes(repo: ScreeningRepository) {
  return async (app: FastifyInstance) => {
    app.addHook("preHandler", app.authenticate);

    // ─── Per-customer screening ────────────────────────────────────

    app.get<{ Params: { customerId: string } }>(
      "/customers/:customerId",
      async (req) => repo.listForCustomer(req.params.customerId),
    );

    app.get<{ Params: { customerId: string } }>(
      "/customers/:customerId/latest",
      async (req) => repo.latestForCustomer(req.params.customerId),
    );

    app.post<{ Params: { customerId: string } }>(
      "/customers/:customerId/run",
      { preHandler: app.requirePermission("screening.run") },
      async (req) => repo.screen(req.params.customerId),
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
        return repo.override(
          req.params.customerId,
          parsed.data.note,
          req.user.sub,
        );
      },
    );

    // ─── Watchlist (mock provider's data source) ───────────────────

    app.get("/watchlist", async () => repo.listWatchlist());

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
        return reply.code(201).send(await repo.addWatchlistEntry(parsed.data));
      },
    );

    app.delete<{ Params: { id: string } }>(
      "/watchlist/:id",
      { preHandler: app.requirePermission("screening.watchlist") },
      async (req) => repo.removeWatchlistEntry(req.params.id),
    );
  };
}
