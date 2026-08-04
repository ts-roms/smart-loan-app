import type { FastifyReply, FastifyRequest } from "fastify";

import {
  assignSchema,
  noteSchema,
  ptpSchema,
  queueScopeSchema,
  resolveSchema,
} from "./schemas";

/**
 * HTTP adapter for the collections surface. Phase 2: stateless;
 * reads `req.collectionsServices!.collections` per call.
 */
export class CollectionsController {
  queue = async (
    req: FastifyRequest<{ Querystring: { scope?: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = queueScopeSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.collectionsServices!.collections.overdueQueue({
      scope: parsed.data.scope,
      actorId: req.user.sub,
    });
  };

  // ─── account ownership ────────────────────────────────────────────

  assignableCollectors = async (req: FastifyRequest) =>
    req.collectionsServices!.collections.assignableCollectors();

  workload = async (req: FastifyRequest) =>
    req.collectionsServices!.collections.workload();

  assign = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.collectionsServices!.collections.assign({
      loanIdOrNumber: req.params.loanId,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      // 404 when the URL names nothing; 422 when the loan is real and
      // it's the collector in the body that can't take the work.
      if (result.kind === "UnknownLoan") {
        return reply
          .code(404)
          .send({ error: "UnknownLoan", message: "No such loan." });
      }
      return reply.code(422).send({
        error: result.kind,
        message:
          result.kind === "UnknownCollector"
            ? "No such user."
            : "That user is deactivated and cannot be assigned accounts.",
      });
    }
    return result.value;
  };

  unassign = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    await req.collectionsServices!.collections.unassign(req.params.loanId);
    // 204 either way — unassigning an account that had no assignment
    // leaves the world in the state the caller asked for.
    return reply.code(204).send();
  };

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
