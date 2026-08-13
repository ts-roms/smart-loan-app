import { LoanProductRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import {
  createSchema,
  loanProductListResponseSchema,
  loanProductResponseSchema,
  productCodeParamSchema,
  seedResponseSchema,
  updateSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    loanProductsRepo?: LoanProductRepository;
  }
}

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
 * Phase 2: the LoanProductRepository is per-request, bound to the
 * tenant's Prisma client. The product-side approval chain endpoints
 * live in ./approval-chain.routes.ts and follow the same pattern.
 */
export async function loanProductRoutes(app: FastifyInstance) {
  // onRequest, not preHandler — the write routes below now declare
  // request schemas, and Fastify validates at preValidation, which runs
  // BEFORE preHandler. Left where it was, an unauthenticated POST with a
  // malformed body came back 400 listing every pricing field the
  // product model has, instead of 401. Same fix as loans.routes.ts.
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.loanProductsRepo = new LoanProductRepository(req.tenantCtx.prisma);
  });

  const TAGS = ["loan-products"];

  app.get(
    "/",
    {
      schema: routeSchema({
        summary:
          "Every loan product with its full underwriting parameter set, " +
          "by code. Any authenticated caller.",
        tags: TAGS,
        response: loanProductListResponseSchema,
        errors: [401],
      }),
    },
    async (req) => req.loanProductsRepo!.list(),
  );

  app.get<{ Params: { code: string } }>(
    "/:code",
    {
      schema: routeSchema({
        summary: "One loan product by code.",
        tags: TAGS,
        params: productCodeParamSchema,
        response: loanProductResponseSchema,
        errors: [401, 404],
      }),
    },
    async (req, reply) => {
      const p = await req.loanProductsRepo!.findByCode(req.params.code);
      if (!p) return reply.code(404).send({ error: "NotFound" });
      return p;
    },
  );

  /** Create a brand-new product. ADMIN only. */
  app.post(
    "/",
    {
      preHandler: app.requirePermission("products.write"),
      schema: routeSchema({
        summary:
          "Create a loan product. The code is UPPER_SNAKE_CASE and " +
          "immutable once set.",
        tags: TAGS,
        body: createSchema,
        response: loanProductResponseSchema,
        status: 201,
        // 409 is the code already existing — every other refusal is 400.
        errors: [400, 401, 403, 409],
      }),
    },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        return reply
          .code(201)
          .send(await req.loanProductsRepo!.create(parsed.data));
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
    {
      preHandler: app.requirePermission("products.write"),
      schema: routeSchema({
        summary:
          "Update a product's parameters. Every field is optional; the " +
          "code itself cannot be changed.",
        tags: TAGS,
        params: productCodeParamSchema,
        body: updateSchema,
        response: loanProductResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return req.loanProductsRepo!.update(req.params.code, parsed.data);
    },
  );

  app.delete<{ Params: { code: string } }>(
    "/:code",
    {
      preHandler: app.requirePermission("products.write"),
      schema: routeSchema({
        summary:
          "Delete a product. Refused with 409 once any loan references " +
          "it — the FK is ON DELETE RESTRICT.",
        tags: TAGS,
        params: productCodeParamSchema,
        response: loanProductResponseSchema,
        errors: [401, 403, 409],
      }),
    },
    async (req, reply) => {
      try {
        return await req.loanProductsRepo!.delete(req.params.code);
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
    {
      preHandler: app.requirePermission("products.write"),
      schema: routeSchema({
        summary:
          "Insert the default product catalog. Never overwrites an " +
          "existing code, so it is safe to re-run.",
        tags: TAGS,
        response: seedResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) => req.loanProductsRepo!.seedDefaults(),
  );
}
