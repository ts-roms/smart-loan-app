import type { FastifyReply, FastifyRequest } from "fastify";

import { runSchema } from "./schemas";

/**
 * Phase 2: stateless. Reads `req.eclServices!.ecl` per call.
 */
export class EclController {
  list = async (req: FastifyRequest) => req.eclServices!.ecl.list();

  run = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = runSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.eclServices!.ecl.run({
      input: parsed.data,
      actorId: req.user.sub,
    });
    return reply.code(201).send(result);
  };
}
