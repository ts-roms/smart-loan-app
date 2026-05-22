import type { FastifyReply, FastifyRequest } from "fastify";

import { listQuerySchema } from "./schemas";

/** Phase 2: stateless. Reads `req.auditServices!.audit` per call. */
export class AuditController {
  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.auditServices!.audit.list(parsed.data);
  };

  listDistinctActions = async (req: FastifyRequest) =>
    req.auditServices!.audit.listDistinctActions();
}
