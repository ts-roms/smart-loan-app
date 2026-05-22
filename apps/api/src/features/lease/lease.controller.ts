import type { FastifyReply, FastifyRequest } from "fastify";

import {
  buyoutSchema,
  closeSchema,
  listQuerySchema,
  pullOutSchema,
} from "./schemas";

/**
 * HTTP layer for lease-to-Own routes. Each handler is a small body-parse
 * + service call + result mapping. The service returns discriminated
 * unions so all 4xx mapping lives here — handlers never throw for flow
 * control.
 *
 * Phase 2: stateless. Reads `req.leaseServices!.lease` per call.
 */
export class LeaseController {
  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.leaseServices!.lease.list(parsed.data);
  };

  findForLoan = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const a = await req.leaseServices!.lease.findForLoan(req.params.loanId);
    if (!a) return reply.code(404).send({ error: "NotFound" });
    return a;
  };

  buyout = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = buyoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.leaseServices!.lease.completeBuyout({
      loanId: req.params.loanId,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return reply.code(201).send({
      agreement: result.agreement,
      journalEntryId: result.journalEntryId,
    });
  };

  pullOut = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = pullOutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.leaseServices!.lease.pullOut({
      loanId: req.params.loanId,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return result.agreement;
  };

  returnUnit = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.leaseServices!.lease.closeAsReturned({
      loanId: req.params.loanId,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return result.agreement;
  };

  extend = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.leaseServices!.lease.closeAsExtended({
      loanId: req.params.loanId,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return result.agreement;
  };
}
