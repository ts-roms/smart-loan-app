import { PaymentIntentRepository, type PrismaClient } from "@loan/db";
import { buildProvider } from "@loan/payments";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import { config } from "../../config";
import { routeSchema } from "../../lib/openapi";
import {
  createIntentSchema,
  intentIdParamSchema,
  intentListQuerySchema,
  intentListResponseSchema,
  paymentIntentResponseSchema,
  sandboxConfirmResponseSchema,
  sandboxParamSchema,
  sandboxTenantParamSchema,
  webhookParamSchema,
  webhookResponseSchema,
  webhookTenantParamSchema,
} from "./schemas";

/**
 * Payment-gateway routes. The provider comes from PAYMENT_PROVIDER via
 * `buildProvider`; unset yields the sandbox MockProvider.
 *
 * Webhook handling:
 *   - POST /payments/webhook/:provider — the gateway calls this when a
 *     payment is confirmed. We parse the payload via the provider's
 *     `parseWebhook` and delegate to the repository.
 *
 *     This endpoint is unauthenticated, and has to be: a gateway carries
 *     no JWT. The signature check inside `parseWebhook` is therefore the
 *     only control on it, which makes the provider selection above a
 *     security decision rather than a configuration detail.
 *
 *     `handleWebhook` requires the intent to already exist, so a forged
 *     callback cannot conjure a payment from nothing. It can still settle
 *     an intent that does exist — and the externalId is handed to the
 *     client at creation — so under MockProvider, which accepts any body,
 *     whoever created an intent can mark it PAID without money moving.
 *     That is acceptable in a sandbox and is why MockProvider must not be
 *     the provider in production.
 *
 *     GCASH and MAYA currently reject every callback: their HMAC check is
 *     unimplemented and they fail closed rather than trust an unverified
 *     one. Implement it in @loan/payments before enabling either.
 *
 *   - POST /payments/mock/confirm/:externalId — sandbox-only, and 404s
 *     unless the configured provider is MOCK. It simulates the customer
 *     paying, so leaving it reachable beside a real gateway would be a
 *     way to settle intents the gateway never saw.
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
 *   • `provider.parseWebhook` — normalises the event shape, and is where
 *     signature verification belongs. The real providers reject
 *     unverified callbacks; MockProvider accepts anything, which is fine
 *     for a sandbox and is why it must not be the provider in production.
 * The handlers below are thin request adapters around those calls;
 * adding a service would be ceremony with no payoff.
 */
export async function paymentsRoutes(app: FastifyInstance) {
  const baseUrl =
    process.env.PUBLIC_API_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`;
  // Selected from PAYMENT_PROVIDER rather than hardcoded, so a deployment
  // that configures a real gateway actually gets one. Unset still yields the
  // sandbox MockProvider, so dev is unaffected; an unrecognised value throws
  // at boot rather than silently falling back to a provider that accepts
  // unsigned callbacks.
  const provider = buildProvider(process.env, baseUrl);

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

  const TAGS = ["payments"];

  /*
   * authenticate at onRequest for the three staff routes, and it has to
   * be per-route rather than a plugin-wide hook: the webhook and
   * sandbox routes below are unauthenticated by design and a group hook
   * would lock the gateway out.
   *
   * The move matters because these routes now declare request schemas,
   * and Fastify validates at preValidation — one stage BEFORE
   * preHandler. With authenticate where it used to be, an
   * unauthenticated POST to /payments/intents with a malformed body was
   * answered 400 describing the intent-creation shape instead of 401.
   */
  const canCreate = {
    onRequest: app.authenticate,
    preHandler: [app.resolveTenant, app.requirePermission("payments.intents")],
  };
  const canRead = {
    onRequest: app.authenticate,
    preHandler: [
      app.resolveTenant,
      app.requirePermission("payments.intents", "loans.read"),
    ],
  };

  app.post(
    "/intents",
    {
      ...canCreate,
      schema: routeSchema({
        summary:
          "Create a gateway payment intent against a loan. Repeat with the " +
          "same idempotencyKey to get the same intent back.",
        tags: TAGS,
        permission: "payments.intents",
        /*
         * `body`, not `header`, and the distinction is the whole reason
         * this is documented. `POST /loans/:id/payments` reads
         * `Idempotency-Key`; this route never looks at it. A caller who
         * generalises from the other endpoint gets a second intent and
         * no error — `parsed.data.idempotencyKey ?? randomUUID()` fills
         * the gap silently.
         */
        idempotency: { mode: "body", field: "idempotencyKey" },
        body: createIntentSchema,
        response: paymentIntentResponseSchema,
        status: 201,
        errors: [400, 401, 403],
      }),
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
      ...canRead,
      schema: routeSchema({
        summary: "One payment intent, by id or PI- number.",
        tags: TAGS,
        permission: ["payments.intents", "loans.read"],
        params: intentIdParamSchema,
        response: paymentIntentResponseSchema,
        errors: [401, 403, 404],
      }),
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
      ...canRead,
      schema: routeSchema({
        summary:
          "Payment intents for one loan, newest first. `loanId` is " +
          "required — there is no unfiltered listing.",
        tags: TAGS,
        permission: ["payments.intents", "loans.read"],
        querystring: intentListQuerySchema,
        response: intentListResponseSchema,
        errors: [400, 401, 403],
      }),
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
    // The URL segment has to name the provider this deployment is actually
    // configured for. Accepting any other value would let a caller pick the
    // parser their forged payload happens to satisfy.
    const name = req.params.provider.toUpperCase();
    if (name !== provider.name) {
      return reply.code(400).send({
        error: "ProviderMismatch",
        message: `This deployment is configured for ${provider.name}, not ${name}.`,
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
        provider: provider.name,
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

  /*
   * RESPONSES ONLY on the webhook pair, and no `body` schema at any
   * price. The body is whatever the gateway sends — its shape belongs
   * to the provider and is checked by `parseWebhook`, which is also
   * where the signature is verified. A JSON Schema in front of that
   * would reject a legitimate callback the provider changed the shape
   * of, and a dropped settlement callback is a payment that never
   * reaches the borrower's balance.
   *
   * `params` is safe: both segments are free strings and the handler
   * compares the provider name itself.
   */
  app.post<{ Params: { provider: string } }>(
    "/webhook/:provider",
    {
      schema: routeSchema({
        summary:
          "Gateway settlement callback (single-tenant). Unauthenticated — " +
          "the provider's signature check is the only control.",
        tags: TAGS,
        public:
          "a payment gateway carries no JWT. The signature verified " +
          "inside `parseWebhook` is the only control on this endpoint.",
        idempotency: {
          mode: "server",
          derivedFrom: "the payment intent id (`intent:<id>`)",
          note:
            "A redelivery of an already-settled intent answers 200 with " +
            "`paymentId: null` — the payment exists, this response just " +
            "does not carry its id. Do not read that null as a failure " +
            "and do not retry on it.",
        },
        params: webhookParamSchema,
        response: webhookResponseSchema,
        // 400 covers both refusals: the URL naming a provider this
        // deployment is not configured for, and a callback `parseWebhook`
        // would not verify or the repository could not apply.
        errors: [400],
      }),
    },
    webhookHandler,
  );
  app.post<{ Params: { provider: string; tenantSlug: string } }>(
    "/webhook/:provider/:tenantSlug",
    {
      schema: routeSchema({
        summary:
          "Gateway settlement callback, tenant named in the URL because a " +
          "callback carries no JWT.",
        tags: TAGS,
        public:
          "as above — no JWT exists for a gateway, which is also why the " +
          "tenant has to ride the URL path instead of a token claim.",
        idempotency: {
          mode: "server",
          derivedFrom: "the payment intent id (`intent:<id>`)",
          note:
            "A redelivery of an already-settled intent answers 200 with " +
            "`paymentId: null` — the payment exists, this response just " +
            "does not carry its id.",
        },
        params: webhookTenantParamSchema,
        response: webhookResponseSchema,
        // 404 is an unknown or suspended tenant slug — deliberately the
        // same answer as a route that does not exist, so the endpoint
        // cannot be used to enumerate tenants.
        errors: [400, 404],
      }),
    },
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
    // This endpoint *is* payment forgery — that's its purpose in the
    // sandbox. It must not exist when a real gateway is configured, or it
    // becomes a way to settle an intent without the gateway ever seeing
    // money. 404 rather than 403: don't advertise it.
    if (provider.name !== "MOCK") {
      return reply.code(404).send({ error: "NotFound" });
    }
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
        provider: provider.name,
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

  /*
   * Same rule as the webhook: params documented, body left alone. The
   * POST form's optional `{ status, amount, reference }` is read with
   * `req.body?.` precisely so a bare POST works — declaring an object
   * body would turn "open the URL and confirm" into a 400.
   */
  const sandboxSummary =
    "Sandbox only: simulate the customer paying. 404s unless the " +
    "configured provider is MOCK — it is payment forgery by design.";

  app.get<{ Params: { externalId: string } }>(
    "/mock/confirm/:externalId",
    {
      schema: routeSchema({
        summary: sandboxSummary,
        tags: TAGS,
        public:
          "it impersonates the gateway, which has no JWT. 404s unless " +
          "the configured provider is MOCK, so it does not exist at all " +
          "beside a real gateway.",
        idempotency: {
          mode: "server",
          derivedFrom: "the payment intent id (`intent:<id>`)",
        },
        params: sandboxParamSchema,
        response: sandboxConfirmResponseSchema,
        errors: [400, 404],
      }),
    },
    sandboxHandler,
  );
  app.post<{ Params: { externalId: string } }>(
    "/mock/confirm/:externalId",
    {
      schema: routeSchema({
        summary: `${sandboxSummary} POST form mirrors a provider callback.`,
        tags: TAGS,
        public:
          "it impersonates the gateway, which has no JWT. 404s unless " +
          "the configured provider is MOCK, so it does not exist at all " +
          "beside a real gateway.",
        idempotency: {
          mode: "server",
          derivedFrom: "the payment intent id (`intent:<id>`)",
        },
        params: sandboxParamSchema,
        response: sandboxConfirmResponseSchema,
        errors: [400, 404],
      }),
    },
    sandboxHandler,
  );
  app.get<{ Params: { tenantSlug: string; externalId: string } }>(
    "/mock/confirm/:tenantSlug/:externalId",
    {
      schema: routeSchema({
        summary: `${sandboxSummary} Tenant named in the URL.`,
        tags: TAGS,
        public:
          "it impersonates the gateway, which has no JWT. 404s unless " +
          "the configured provider is MOCK.",
        idempotency: {
          mode: "server",
          derivedFrom: "the payment intent id (`intent:<id>`)",
        },
        params: sandboxTenantParamSchema,
        response: sandboxConfirmResponseSchema,
        errors: [400, 404],
      }),
    },
    sandboxHandler,
  );
  app.post<{ Params: { tenantSlug: string; externalId: string } }>(
    "/mock/confirm/:tenantSlug/:externalId",
    {
      schema: routeSchema({
        summary: `${sandboxSummary} Tenant named in the URL, POST form.`,
        tags: TAGS,
        public:
          "it impersonates the gateway, which has no JWT. 404s unless " +
          "the configured provider is MOCK.",
        idempotency: {
          mode: "server",
          derivedFrom: "the payment intent id (`intent:<id>`)",
        },
        params: sandboxTenantParamSchema,
        response: sandboxConfirmResponseSchema,
        errors: [400, 404],
      }),
    },
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
