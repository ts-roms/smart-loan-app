import type { FastifyReply, FastifyRequest } from "fastify";

import type { PublicService } from "./public.service";
import { captureLeadSchema } from "./schemas";

/**
 * HTTP adapter for the anonymous /public/* surface.
 *
 * No JWT, no permission checks. The rate limit (configured in
 * public.routes.ts) is the only abuse control; downstream validation
 * is via zod with tight bounds.
 */
export class PublicController {
  constructor(private readonly service: PublicService) {}

  captureLead = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = captureLeadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.captureLead({ input: parsed.data });
    if (!result.ok) {
      return reply.code(429).send({
        error: result.kind,
        message: result.message,
      });
    }
    // Don't echo the lead id — it's not useful to the client and
    // gives a tiny information advantage to a scraper trying to
    // enumerate. The 201 is the acknowledgement.
    return reply.code(201).send({ ok: true });
  };
}
