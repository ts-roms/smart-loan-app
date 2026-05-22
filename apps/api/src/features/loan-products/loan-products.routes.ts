import { LoanProductRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { createSchema, updateSchema } from "./schemas.js";

/**
 * Loan product CRUD. The product model carries the full set of
 * underwriting parameters per product (rate band + LTV cap + fees +
 * KYC requirements + tiered rate/LTV) — see libs/db/prisma/schema.prisma
 * for the full LoanProduct schema.
 *
 * Layer note (see docs/architecture.md): no controller/service split.
 * Every handler is a direct LoanProductRepository call; the only
 * "orchestration" is mapping repo conflicts to 409. Per the doc rule
 * "don't add layers for symmetry," the layered split would be pure
 * ceremony here. Promote to the full pattern only if real
 * application-layer logic accumulates (e.g. multi-step pricing
 * recompute, archive flow, cross-product validation).
 *
 * The product-side approval chain endpoints live in
 * ./approval-chain.routes.ts and follow the same pragma — the audit
 * write on PUT is mild orchestration but not enough to earn the split.
 */
export async function loanProductRoutes(app: FastifyInstance) {
  const products = new LoanProductRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => products.list());

  app.get<{ Params: { code: string } }>("/:code", async (req, reply) => {
    const p = await products.findByCode(req.params.code);
    if (!p) return reply.code(404).send({ error: "NotFound" });
    return p;
  });

  /** Create a brand-new product. ADMIN only. */
  app.post(
    "/",
    { preHandler: app.requirePermission("products.write") },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        return reply.code(201).send(await products.create(parsed.data));
      } catch (err) {
        return reply.code(409).send({
          error: "Conflict",
          message: (err as Error).message,
        });
      }
    },
  );

  app.patch<{ Params: { code: string } }>(
    "/:code",
    { preHandler: app.requirePermission("products.write") },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return products.update(req.params.code, parsed.data);
    },
  );

  app.delete<{ Params: { code: string } }>(
    "/:code",
    { preHandler: app.requirePermission("products.write") },
    async (req, reply) => {
      try {
        return await products.delete(req.params.code);
      } catch {
        return reply.code(409).send({
          error: "Conflict",
          message: "Product cannot be deleted — loans reference it.",
        });
      }
    },
  );

  app.post(
    "/seed",
    { preHandler: app.requirePermission("products.write") },
    async () => products.seedDefaults(),
  );
}
