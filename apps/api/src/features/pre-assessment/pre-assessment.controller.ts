import type { FastifyReply, FastifyRequest } from "fastify";

import { preAssessmentQuerySchema, preAssessmentSchema } from "./schemas";

/**
 * HTTP adapter for staff-facing pre-assessment. Stateless singleton;
 * reads the per-request service off `req.preAssessmentServices` (Phase 2
 * pattern — see docs/architecture.md).
 */
export class PreAssessmentController {
  run = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = preAssessmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.preAssessmentServices!.preAssessments.run({
      input: parsed.data,
      source: "OFFICER",
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(404)
        .send({ error: "NotFound", message: "Customer not found." });
    }
    return reply.code(201).send(result.assessment);
  };

  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = preAssessmentQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.preAssessmentServices!.preAssessments.list(parsed.data);
  };

  get = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const found = await req.preAssessmentServices!.preAssessments.get(
      req.params.id,
    );
    if (!found) return reply.code(404).send({ error: "NotFound" });
    return found;
  };
}
