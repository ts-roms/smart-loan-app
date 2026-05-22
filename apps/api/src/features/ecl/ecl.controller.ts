import type { FastifyReply, FastifyRequest } from "fastify";

import type { EclService } from "./ecl.service";
import { runSchema } from "./schemas";

export class EclController {
  constructor(private readonly service: EclService) {}

  list = async () => this.service.list();

  run = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = runSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.run({
      input: parsed.data,
      actorId: req.user.sub,
    });
    return reply.code(201).send(result);
  };
}
