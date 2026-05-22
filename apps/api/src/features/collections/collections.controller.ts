import type { FastifyReply, FastifyRequest } from "fastify";

import { noteSchema, ptpSchema, resolveSchema } from "./schemas";

/**
 * HTTP adapter for the collections surface. Phase 2: stateless;
 * reads `req.collectionsServices!.collections` per call.
 */
export class CollectionsController {
  queue = async (req: FastifyRequest) =>
    req.collectionsServices!.collections.overdueQueue();

  // ─── notes ────────────────────────────────────────────────────────

  listNotes = async (req: FastifyRequest<{ Params: { loanId: string } }>) =>
    req.collectionsServices!.collections.listNotes(req.params.loanId);

  addNote = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return reply.code(201).send(
      await req.collectionsServices!.collections.addNote({
        loanId: req.params.loanId,
        input: parsed.data,
        actorId: req.user.sub,
      }),
    );
  };

  // ─── promises to pay ──────────────────────────────────────────────

  listPromises = async (req: FastifyRequest<{ Params: { loanId: string } }>) =>
    req.collectionsServices!.collections.listPromises(req.params.loanId);

  createPromise = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = ptpSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return reply.code(201).send(
      await req.collectionsServices!.collections.createPromise({
        loanId: req.params.loanId,
        input: parsed.data,
        actorId: req.user.sub,
      }),
    );
  };

  resolvePromise = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = resolveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.collectionsServices!.collections.resolvePromise(
      req.params.id,
      parsed.data,
    );
  };

  // ─── late-fee accrual job ─────────────────────────────────────────

  accrueLateFees = async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await req.collectionsServices!.collections.accrueLateFees(
      req.user.sub,
    );
    if (!result.ok) {
      return reply
        .code(409)
        .send({ error: "AccrualFailed", message: result.message });
    }
    return result.result;
  };
}
