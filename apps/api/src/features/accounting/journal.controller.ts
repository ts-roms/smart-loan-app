import type { FastifyReply, FastifyRequest } from "fastify";

import { entrySchema, reverseBulkSchema, reverseSingleSchema } from "./schemas";

/**
 * HTTP adapter for the three journal write endpoints
 * (POST /journal, POST /journal/:id/reverse, POST /journal/reverse-bulk).
 * Read endpoints stay inline in accounting.routes.ts.
 *
 * Phase 2: stateless. Each method reads `req.accountingCtx!.journal`.
 */
export class JournalController {
  post = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = entrySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.accountingCtx!.journal.post(
      parsed.data,
      req.user.sub,
    );
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return reply.code(201).send(result.entry);
  };

  reverse = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = reverseSingleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.accountingCtx!.journal.reverse(
      req.params.id,
      parsed.data,
      req.user.sub,
    );
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return reply.code(201).send({
      original: result.original,
      reversal: result.reversal,
      alreadyReversed: result.alreadyReversed,
    });
  };

  reverseBulk = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = reverseBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.accountingCtx!.journal.reverseBulk(
      parsed.data,
      req.user.sub,
    );
    return reply.code(207).send(result);
  };
}
