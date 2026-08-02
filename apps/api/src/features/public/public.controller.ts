import type { FastifyReply, FastifyRequest } from "fastify";

import type { PublicService } from "./public.service";
import { captureLeadSchema, signupTenantSchema } from "./schemas";

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

  /**
   * Self-serve cooperative signup. Unlike every other endpoint on this
   * surface, the response body is sensitive: it carries the bootstrap
   * admin password, which exists nowhere else after this request.
   */
  signupTenant = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = signupTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.signupTenant({ input: parsed.data });
    if (result.ok) return reply.code(201).send(result);

    switch (result.kind) {
      case "SlugTaken":
        return reply
          .code(409)
          .send({ error: result.kind, message: result.message });
      case "ModeDisabled":
        // 501 rather than 403: the caller did nothing wrong, this
        // installation just doesn't implement hosted signup.
        return reply
          .code(501)
          .send({ error: result.kind, message: result.message });
      case "ProvisioningFailed":
        return reply
          .code(500)
          .send({ error: result.kind, message: result.message });
    }
  };
}
