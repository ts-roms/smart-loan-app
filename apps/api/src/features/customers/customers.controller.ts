import type { FastifyReply, FastifyRequest } from "fastify";

import { customerBaseSchema, customerSchema } from "./schemas.js";
import type { CustomerService } from "./customers.service.js";

/**
 * Presentation layer for the base customer CRUD surface. Controllers
 * own the wire shape: zod parse, error → 4xx mapping, call service,
 * format response. They never touch the database or external providers
 * directly — that's the service's job.
 */
export class CustomerController {
  constructor(private readonly service: CustomerService) {}

  list = async () => this.service.list();

  show = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const c = await this.service.findByIdOrNumber(req.params.id);
    if (!c) return reply.code(404).send({ error: "NotFound" });
    return c;
  };

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const created = await this.service.create(parsed.data);
    return reply.code(201).send(created);
  };

  summary = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.summary(req.params.id);
    if (!result) return reply.code(404).send({ error: "NotFound" });
    return result;
  };

  repeatEligibility = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.repeatEligibility(req.params.id);
    if (!result) return reply.code(404).send({ error: "NotFound" });
    return result;
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = customerBaseSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const updated = await this.service.update(req.params.id, parsed.data);
    if (!updated) return reply.code(404).send({ error: "NotFound" });
    return updated;
  };
}
