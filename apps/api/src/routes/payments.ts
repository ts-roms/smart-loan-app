import { PaymentIntentRepository } from "@loan/db";
import { MockProvider } from "@loan/payments";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const createIntentSchema = z.object({
  loanId: z.string().uuid(),
  amount: z.number().positive(),
  description: z.string().max(200).optional(),
  /**
   * Optional. If absent, the API allocates a fresh UUID — meaning each call
   * creates a new intent. Pass a stable key to make the create idempotent.
   */
  idempotencyKey: z.string().min(1).max(120).optional(),
});

/**
 * Payment-gateway routes. Today only the MockProvider is wired up; real
 * providers (GCash, Maya) plug in by passing a different `PaymentProvider`
 * implementation to PaymentIntentRepository.
 *
 * Webhook handling:
 *   - POST /payments/webhook/:provider — the provider calls this when a
 *     payment is confirmed. We parse the payload via the provider's
 *     `parseWebhook` (which verifies signatures for real providers) and
 *     delegate to the repository.
 *   - POST /payments/mock/confirm/:externalId — sandbox-only. Hitting this
 *     URL simulates the customer paying and fires our own webhook handler.
 */
export async function paymentsRoutes(app: FastifyInstance) {
  const baseUrl =
    process.env.PUBLIC_API_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`;
  const provider = new MockProvider({ baseUrl });
  const intents = new PaymentIntentRepository(app.prisma, provider);

  // ─── Authenticated routes ─────────────────────────────────────────

  app.post(
    "/intents",
    { preHandler: [app.authenticate] },
    async (req: FastifyRequest, reply) => {
      const parsed = createIntentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const intent = await intents.create({
        loanId: parsed.data.loanId,
        amount: parsed.data.amount,
        description: parsed.data.description,
        idempotencyKey: parsed.data.idempotencyKey ?? randomUUID(),
        webhookUrl: `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}`,
        createdById: req.user.sub,
      });
      return reply.code(201).send(intent);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/intents/:id",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const intent = await intents.findByIdOrNumber(req.params.id);
      if (!intent) return reply.code(404).send({ error: "NotFound" });
      return intent;
    },
  );

  app.get<{ Querystring: { loanId?: string } }>(
    "/intents",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      if (!req.query.loanId) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "loanId required" });
      }
      return intents.list(req.query.loanId);
    },
  );

  // ─── Public webhook (no auth — verified via provider signature in real ones) ──

  app.post<{ Params: { provider: string } }>(
    "/webhook/:provider",
    async (req, reply) => {
      const name = req.params.provider.toUpperCase();
      if (name !== "MOCK") {
        // Real providers (GCASH/MAYA) would dispatch here.
        return reply
          .code(501)
          .send({
            error: "NotImplemented",
            message: `Provider ${name} not wired`,
          });
      }
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
    },
  );

  // ─── Sandbox: simulate the customer paying ─────────────────────────
  //
  // GET version makes it easy to "pay" by opening the URL the intent
  // returned. POST version mirrors a real provider's callback shape.

  const sandboxHandler = async (
    req: FastifyRequest<{
      Params: { externalId: string };
      Body?: { status?: string; amount?: number; reference?: string };
    }>,
    reply: import("fastify").FastifyReply,
  ) => {
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
}
