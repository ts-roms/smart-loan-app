import type { FastifyReply, FastifyRequest } from "fastify";

import type { LeaseService } from "./lease.service";
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
 * control. Methods are arrow-field bound so Fastify's route registration
 * can use them directly without `.bind(this)` plumbing.
 */
export class LeaseController {
  constructor(private readonly service: LeaseService) {}

  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return this.service.list(parsed.data);
  };

  findForLoan = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
    reply: FastifyReply,
  ) => {
    const a = await this.service.findForLoan(req.params.loanId);
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
    const result = await this.service.completeBuyout({
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
    const result = await this.service.pullOut({
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
    const result = await this.service.closeAsReturned({
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
    const result = await this.service.closeAsExtended({
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
