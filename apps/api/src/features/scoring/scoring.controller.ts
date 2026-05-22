import type { FastifyReply, FastifyRequest } from "fastify";

import type { ScoringService } from "./scoring.service";
import { submitSurveySchema, tierQuerySchema } from "./schemas";

export class ScoringController {
  constructor(private readonly service: ScoringService) {}

  questions = async () => this.service.getQuestions();

  submit = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = submitSurveySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.submit({
      input: parsed.data,
      actorId: req.user.sub,
    });
    return reply.code(201).send(result);
  };

  latestForCustomer = async (
    req: FastifyRequest<{ Params: { customerId: string } }>,
    reply: FastifyReply,
  ) => {
    const s = await this.service.latestForCustomer(req.params.customerId);
    if (!s) {
      return reply
        .code(404)
        .send({ error: "NotFound", message: "No score yet" });
    }
    return s;
  };

  tier = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = tierQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: "score query required" });
    }
    return this.service.tier(parsed.data.score);
  };
}
