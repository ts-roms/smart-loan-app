import type { FastifyReply, FastifyRequest } from "fastify";

import { submitSurveySchema, tierQuerySchema } from "./schemas";

/**
 * HTTP adapter for the credit-scoring surface.
 *
 * Phase 2: stateless. Each method reads `req.scoringServices!.scoring`
 * — built per-request from the tenant-scoped Prisma client.
 */
export class ScoringController {
  questions = async (req: FastifyRequest) =>
    req.scoringServices!.scoring.getQuestions();

  submit = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = submitSurveySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.scoringServices!.scoring.submit({
      input: parsed.data,
      actorId: req.user.sub,
    });
    return reply.code(201).send(result);
  };

  latestForCustomer = async (
    req: FastifyRequest<{ Params: { customerId: string } }>,
    reply: FastifyReply,
  ) => {
    const s = await req.scoringServices!.scoring.latestForCustomer(
      req.params.customerId,
    );
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
    return req.scoringServices!.scoring.tier(parsed.data.score);
  };
}
