import type { FastifyReply, FastifyRequest } from "fastify";

import { createRuleSchema, updateRuleSchema } from "./schemas";

/** Phase 2: stateless. Reads `req.decisionRulesServices!.rules`. */
export class DecisionRuleController {
  list = async (req: FastifyRequest) => req.decisionRulesServices!.rules.list();

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.decisionRulesServices!.rules.create(parsed.data);
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
    return req.decisionRulesServices!.rules.update(req.params.id, parsed.data);
  };

  delete = async (req: FastifyRequest<{ Params: { id: string } }>) =>
    req.decisionRulesServices!.rules.delete(req.params.id);

  seedDefaults = async (req: FastifyRequest) =>
    req.decisionRulesServices!.rules.seedDefaults();
}
