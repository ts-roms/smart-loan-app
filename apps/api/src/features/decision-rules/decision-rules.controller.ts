import type { FastifyReply, FastifyRequest } from "fastify";

import type { DecisionRuleService } from "./decision-rules.service.js";
import { createRuleSchema, updateRuleSchema } from "./schemas.js";

export class DecisionRuleController {
  constructor(private readonly service: DecisionRuleService) {}

  list = async () => this.service.list();

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.create(parsed.data);
    if (!result.ok) {
      return reply
        .code(409)
        .send({ error: "Conflict", message: result.message });
    }
    return reply.code(201).send(result.rule);
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = updateRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return this.service.update(req.params.id, parsed.data);
  };

  delete = async (req: FastifyRequest<{ Params: { id: string } }>) =>
    this.service.delete(req.params.id);

  seedDefaults = async () => this.service.seedDefaults();
}
