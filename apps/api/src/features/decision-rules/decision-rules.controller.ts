import { DecisionRuleNotFoundError, DecisionRuleRetiredError } from "@loan/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  asOfQuerySchema,
  createRuleSchema,
  retireRuleSchema,
  updateRuleSchema,
} from "./schemas";

/** Phase 2: stateless. Reads `req.decisionRulesServices!.rules`. */
export class DecisionRuleController {
  list = async (req: FastifyRequest) => req.decisionRulesServices!.rules.list();

  /**
   * The rule set as it stood at `?at=`. Answers the question a per-loan
   * stamp cannot: not just which rule fired, but what else was in force
   * — including the rules that were switched off that week.
   */
  asOf = async (
    req: FastifyRequest<{ Querystring: { at?: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = asOfQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.decisionRulesServices!.rules.asOf(parsed.data.at);
  };

  history = async (req: FastifyRequest<{ Params: { id: string } }>) =>
    req.decisionRulesServices!.rules.history(req.params.id);

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.decisionRulesServices!.rules.create(
      parsed.data,
      req.user.sub,
    );
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
    try {
      return await req.decisionRulesServices!.rules.update(
        req.params.id,
        parsed.data,
        req.user.sub,
      );
    } catch (err) {
      if (err instanceof DecisionRuleNotFoundError) {
        return reply
          .code(404)
          .send({ error: "NotFound", message: err.message });
      }
      /*
       * 409, not 400: the request is well-formed and the caller is
       * entitled to make it — the rule's state is what refuses. Same
       * convention as every other state-refusal in this API.
       */
      if (err instanceof DecisionRuleRetiredError) {
        return reply
          .code(409)
          .send({ error: "Conflict", message: err.message });
      }
      throw err;
    }
  };

  /** Retires rather than erases — see DecisionRuleService.retire. */
  delete = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = retireRuleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      return await req.decisionRulesServices!.rules.retire(
        req.params.id,
        req.user.sub,
        parsed.data.changeNote,
      );
    } catch (err) {
      if (err instanceof DecisionRuleNotFoundError) {
        return reply
          .code(404)
          .send({ error: "NotFound", message: err.message });
      }
      throw err;
    }
  };

  seedDefaults = async (req: FastifyRequest) =>
    req.decisionRulesServices!.rules.seedDefaults();
}
