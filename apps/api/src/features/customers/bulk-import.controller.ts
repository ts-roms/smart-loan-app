import type { FastifyReply, FastifyRequest } from "fastify";

import type { BulkImportService } from "./bulk-import.service.js";
import { bulkImportSchema } from "./schemas.js";

/**
 * HTTP adapter for the bulk customer import flow. Validates the
 * envelope (rows array + flags), hands the work to the service, and
 * always responds with 207 Multi-Status — partial success is the
 * default expectation here, never the exception.
 */
export class BulkImportController {
  constructor(private readonly service: BulkImportService) {}

  run = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = bulkImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.run(parsed.data);
    return reply.code(207).send(result);
  };
}
