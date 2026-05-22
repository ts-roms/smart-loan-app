import type { FastifyReply, FastifyRequest } from "fastify";

import type { AuditService } from "./audit.service.js";
import { listQuerySchema } from "./schemas.js";

export class AuditController {
  constructor(private readonly service: AuditService) {}

  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return this.service.list(parsed.data);
  };

  listDistinctActions = async () => this.service.listDistinctActions();
}
