import { PaymentIntentRepository, type PrismaClient } from "@loan/db";
import { MockProvider } from "@loan/payments";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import { config } from "../../config";
import { createIntentSchema } from "./schemas";

/**
 * Payment-gateway routes. Today only the MockProvider is wired up;
 * real providers (GCash, Maya) plug in by passing a different
 * `PaymentProvider` implementation to PaymentIntentRepository.
 *
 * Webhook handling:
 *   - POST /payments/webhook/:provider — the provider calls this when a
 *     payment is confirmed. We parse the payload via the provider's
 *     `parseWebhook` (which verifies signatures for real providers) and
 *     delegate to the repository.
 *   - POST /payments/mock/confirm/:externalId — sandbox-only. Hitting
 *     this URL simulates the customer paying and fires our own webhook
 *     handler.
 *
 * Phase 2 multi-tenant: webhooks have no JWT, so the tenant has to
 * ride the URL itself. We accept an optional `:tenantSlug` path
 * segment; in single-tenant mode it's omitted and the handler falls
 * back to `app.prisma`. The intent creation path embeds the slug into
 * the webhookUrl it tells the provider so the callback reaches the
 * right schema.
 *
 * Layer note (see docs/architecture.md): no controller/service split.
 * The interesting business logic lives in
 *   • `PaymentIntentRepository.handleWebhook` — settles the intent and
 *     posts the LoanPayment + journal entry inside one transaction.
 *   • `provider.parseWebhook` — verifies the signature and normalises
 *     the event shape.
 * The handlers below are thin request adapters around those calls;
 * adding a service would be ceremony with no payoff.
 */
export async function paymentsRoutes(app: FastifyInstance) {
  const baseUrl =
    process.env.PUBLIC_API_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`;
  const provider = new MockProvider({ baseUrl });

  // ─── Authenticated routes ─────────────────────────────────────────
  //
  // Staff-side intent management. `loanId` comes from the request, so
  // these are not self-scoped — a borrower creating an intent against
  // someone else's loan would push a payment into the wrong ledger.
  // Creation takes `payments.intents` (ACCOUNTANT + ADMIN); the reads
  // also accept `loans.read` so a servicing officer can see whether a
  // borrower's gateway payment settled without holding the cash keys.
  // Borrowers use POST/GET /portal/payments/intents, which resolves the
  // customer from the JWT and re-checks loan ownership.

  app.post(
    "/intents",
    {
      preHandler: [
        app.authenticate,
        app.resolveTenant,
        app.requirePermission("payments.intents"),
      ],
    },
    async (req: FastifyRequest, reply) => {
      const parsed = createIntentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const intents = new PaymentIntentRepository(
        req.tenantCtx.prisma,
        provider,
      );
      // Embed the tenant slug in the webhook URL so the provider's
      // callback can reach the right schema. In single-tenant mode we
      // omit the segment for shorter URLs that match the legacy shape.
      const webhookUrl = config.multiTenant
        ? `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}/${req.tenantCtx.slug}`
        : `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}`;
      const intent = await intents.create({
        loanId: parsed.data.loanId,
        amount: parsed.data.amount,
        description: parsed.data.description,
        idempotencyKey: parsed.data.idempotencyKey ?? randomUUID(),
        webhookUrl,
        createdById: req.user.sub,
      });
      return reply.code(201).send(intent);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/intents/:id",
    {
      preHandler: [
        app.authenticate,
        app.resolveTenant,
        app.requirePermission("payments.intents", "loans.read"),
      ],
    },
    async (req, reply) => {
      const intents = new PaymentIntentRepository(
        req.tenantCtx.prisma,
        provider,
      );
      const intent = await intents.findByIdOrNumber(req.params.id);
      if (!intent) return reply.code(404).send({ error: "NotFound" });
      return intent;
    },
  );

  app.get<{ Querystring: { loanId?: string } }>(
    "/intents",
    {
      preHandler: [
        app.authenticate,
        app.resolveTenant,
        app.requirePermission("payments.intents", "loans.read"),
      ],
    },
    async (req, reply) => {
      if (!req.query.loanId) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "loanId required" });
      }
      const intents = new PaymentIntentRepository(
        req.tenantCtx.prisma,
        provider,
      );
      return intents.list(req.query.loanId);
    },
  );

  // ─── Public webhook (no auth — verified via provider signature) ────
  //
  // Two route shapes:
  //   /webhook/:provider                     — single-tenant fallback
  //   /webhook/:provider/:tenantSlug         — multi-tenant
  //
  // Both call the same handler; resolveWebhookTenantPrisma figures out
  // which schema to talk to. Registering both shapes keeps legacy
  // single-tenant webhooks working without URL surgery.

  const webhookHandler = async (
    req: FastifyRequest<{ Params: { provider: string; tenantSlug?: string } }>,
    reply: FastifyReply,
  ) => {
    const name = req.params.provider.toUpperCase();
    if (name !== "MOCK") {
      // Real providers (GCASH/MAYA) would dispatch here.
      return reply.code(501).send({
        error: "NotImplemented",
        message: `Provider ${name} not wired`,
      });
    }
    const prisma = await resolveWebhookTenantPrisma(
      app,
      req.params.tenantSlug,
      reply,
    );
    if (!prisma) return; // resolver already sent the error
    const intents = new PaymentIntentRepository(prisma, provider);
    try {
      const event = provider.parseWebhook(
        req.headers as Record<string, string>,
        req.body,
      );
      const result = await intents.handleWebhook({
        provider: "MOCK",
        externalId: event.externalId,
        status: event.status,
        amount: event.amount,
        reference: event.reference,
      });
      return {
        ok: true,
        status: result.intent.status,
        paymentId: result.payment?.id ?? null,
      };
    } catch (err) {
      return reply.code(400).send({
        error: "BadWebhook",
        message: (err as Error).message,
      });
    }
  };

  app.post<{ Params: { provider: string } }>(
    "/webhook/:provider",
    webhookHandler,
  );
  app.post<{ Params: { provider: string; tenantSlug: string } }>(
    "/webhook/:provider/:tenantSlug",
    webhookHandler,
  );

  // ─── Sandbox: simulate the customer paying ─────────────────────────
  //
  // GET version makes it easy to "pay" by opening the URL the intent
  // returned. POST version mirrors a real provider's callback shape.

  const sandboxHandler = async (
    req: FastifyRequest<{
      Params: { externalId: string; tenantSlug?: string };
      Body?: { status?: string; amount?: number; reference?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const prisma = await resolveWebhookTenantPrisma(
      app,
      req.params.tenantSlug,
      reply,
    );
    if (!prisma) return;
    const intents = new PaymentIntentRepository(prisma, provider);
    const status = req.body?.status ?? "PAID";
    try {
      const event = provider.parseWebhook(
        req.headers as Record<string, string>,
        {
          externalId: req.params.externalId,
          status,
          amount: req.body?.amount,
          reference: req.body?.reference,
        },
      );
      const result = await intents.handleWebhook({
        provider: "MOCK",
        externalId: event.externalId,
        status: event.status,
        amount: event.amount,
        reference: event.reference,
      });
      return {
        ok: true,
        intentStatus: result.intent.status,
        paymentId: result.payment?.id ?? null,
      };
    } catch (err) {
      return reply.code(400).send({
        error: "BadSandbox",
        message: (err as Error).message,
      });
    }
  };

  app.get<{ Params: { externalId: string } }>(
    "/mock/confirm/:externalId",
    sandboxHandler,
  );
  app.post<{ Params: { externalId: string } }>(
    "/mock/confirm/:externalId",
    sandboxHandler,
  );
  app.get<{ Params: { tenantSlug: string; externalId: string } }>(
    "/mock/confirm/:tenantSlug/:externalId",
    sandboxHandler,
  );
  app.post<{ Params: { tenantSlug: string; externalId: string } }>(
    "/mock/confirm/:tenantSlug/:externalId",
    sandboxHandler,
  );
}

/**
 * Resolve which Prisma client a webhook/sandbox handler should use.
 * Webhooks have no JWT, so the slug comes from the URL path. In
 * single-tenant mode the slug is absent and we fall back to
 * `app.prisma` (public schema).
 *
 * On any resolution failure (unknown slug, non-ACTIVE tenant) the
 * handler sends a 404 and returns null — webhooks should not leak
 * which slugs exist.
 */
async function resolveWebhookTenantPrisma(
  app: FastifyInstance,
  tenantSlug: string | undefined,
  reply: FastifyReply,
): Promise<PrismaClient | null> {
  if (!config.multiTenant) {
    // Single-tenant: ignore the slug if present and use app.prisma.
    return app.prisma;
  }
  if (!tenantSlug || !/^[a-z][a-z0-9-]+$/.test(tenantSlug)) {
    await reply.code(404).send({ error: "NotFound" });
    return null;
  }
  const tenant = await app.prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "ACTIVE") {
    await reply.code(404).send({ error: "NotFound" });
    return null;
  }
  return app.tenantPrisma.get(tenantSlug);
}
