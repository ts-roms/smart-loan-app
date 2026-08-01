import type { FastifyReply, FastifyRequest } from "fastify";

import type { ApproveResult, LetterResult } from "./demand-letters.service";
import {
  approveSchema,
  batchSchema,
  candidatesQuerySchema,
  closeSchema,
  dispatchSchema,
  listQuerySchema,
} from "./schemas";

/**
 * HTTP adapter for demand letters. Owns body parsing and the mapping
 * from service result kinds to HTTP codes; service stays
 * framework-free.
 *
 * Phase 2: stateless. Each method reads
 * `req.demandLetterServices!.demandLetters` per call. The caller-
 * perms resolver is also passed through req (set by the routes
 * preHandler) so the controller stays free of FastifyInstance.
 */
export class DemandLetterController {
  candidates = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = candidatesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.demandLetterServices!.demandLetters.identifyCandidates(
      parsed.data.stage,
    );
  };

  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.demandLetterServices!.demandLetters.list(parsed.data);
  };

  findById = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const letter = await req.demandLetterServices!.demandLetters.findById(
      req.params.id,
    );
    if (!letter) return reply.code(404).send({ error: "NotFound" });
    return letter;
  };

  batch = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = batchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.demandLetterServices!.demandLetters.draftBatch({
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return reply
      .code(201)
      .send({ created: result.letters.length, letters: result.letters });
  };

  approve = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const callerPerms =
      req.permissions ??
      (await req.demandLetterServices!.resolveCallerPerms(req.user.sub));
    const result = await req.demandLetterServices!.demandLetters.approve({
      id: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
      callerPerms,
    });
    if (!result.ok) return this.mapApproveError(result, reply);
    return result.letter;
  };

  dispatch = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = dispatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.demandLetterServices!.demandLetters.dispatch({
      id: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapLetterError(result, reply);
    return result.letter;
  };

  close = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.demandLetterServices!.demandLetters.close({
      id: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapLetterError(result, reply);
    return result.letter;
  };

  // ─── error mapping ────────────────────────────────────────────────

  private mapApproveError(
    result: Extract<ApproveResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    switch (result.kind) {
      case "NotFound":
        return reply.code(404).send({ error: "NotFound" });
      case "ForbiddenStagePerm":
      case "ForbiddenSelfApprove":
        return reply
          .code(403)
          .send({ error: "Forbidden", message: result.message });
      case "RepoError":
      default:
        return reply
          .code(400)
          .send({ error: "BadRequest", message: result.message });
    }
  }

  private mapLetterError(
    result: Extract<LetterResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    return reply
      .code(400)
      .send({ error: "BadRequest", message: result.message });
  }
}
