import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  AuctionOutcome,
  CaseResult,
  RepossessionService,
} from "./repossession.service.js";
import {
  approvalSchema,
  assignSchema,
  auctionSchema,
  cancelSchema,
  listQuerySchema,
  openSchema,
  recoverSchema,
} from "./schemas.js";

/**
 * HTTP adapter for repossession. All 4xx mapping lives here so the
 * service can stay framework-free. The repo errors (invalid transitions,
 * etc.) come through as 400s; not-found is 404; everything else 201/200.
 */
export class RepossessionController {
  constructor(private readonly service: RepossessionService) {}

  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return this.service.list(parsed.data);
  };

  findById = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const c = await this.service.findById(req.params.id);
    if (!c) return reply.code(404).send({ error: "NotFound" });
    return c;
  };

  outstanding = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.outstanding(req.params.id);
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return {
      outstandingPrincipal: result.outstandingPrincipal,
      outstandingPenalties: result.outstandingPenalties,
      totalOutstanding: result.totalOutstanding,
    };
  };

  open = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.openCase({
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapCaseError(result, reply);
    return reply.code(201).send(result.case);
  };

  bmApprove = (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => this.runApproval(req, reply, "bmApprove");
  creditApprove = (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => this.runApproval(req, reply, "creditApprove");
  legalApprove = (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => this.runApproval(req, reply, "legalApprove");

  assignAgent = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.assignAgent({
      caseId: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapCaseError(result, reply);
    return result.case;
  };

  recover = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = recoverSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.recover({
      caseId: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapCaseError(result, reply);
    return result.case;
  };

  auction = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = auctionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const outcome = await this.service.auction({
      caseId: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!outcome.ok) return this.mapAuctionError(outcome, reply);
    return reply.code(201).send(outcome.result);
  };

  cancel = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.cancel({
      caseId: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapCaseError(result, reply);
    return result.case;
  };

  // ─── internals ────────────────────────────────────────────────────

  private async runApproval(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    method: "bmApprove" | "creditApprove" | "legalApprove",
  ) {
    const parsed = approvalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service[method]({
      caseId: req.params.id,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapCaseError(result, reply);
    return result.case;
  }

  private mapCaseError(
    result: Extract<CaseResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    return reply
      .code(400)
      .send({ error: "BadRequest", message: result.message });
  }

  private mapAuctionError(
    outcome: Extract<AuctionOutcome, { ok: false }>,
    reply: FastifyReply,
  ) {
    return reply
      .code(400)
      .send({ error: "BadRequest", message: outcome.message });
  }
}
