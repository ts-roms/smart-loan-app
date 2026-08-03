import type { FastifyReply, FastifyRequest } from "fastify";

import type { PublicService } from "./public.service";
import {
  captureLeadSchema,
  confirmSignupSchema,
  signupTenantSchema,
} from "./schemas";

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
   * Self-serve signup, step 1. Records the request and emails a link.
   * 202 rather than 201 — nothing has been created yet, which is the
   * entire point of the step.
   */
  requestSignup = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = signupTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.requestTenantSignup({
      input: parsed.data,
    });
    if (result.ok) return reply.code(202).send(result);

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
    }
  };

  /**
   * Self-serve signup, step 2 — the one that actually provisions.
   * Unlike every other endpoint on this surface, the response body is
   * sensitive: it carries the bootstrap admin password, which exists
   * nowhere else after this request.
   */
  confirmSignup = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = confirmSignupSchema.safeParse(req.body);
    if (!parsed.success) {
      // A malformed token is indistinguishable from a wrong one as far
      // as the caller is concerned, so don't echo zod's field detail.
      return reply.code(400).send({
        error: "InvalidToken",
        message: "That confirmation link isn't valid.",
      });
    }
    const result = await this.service.confirmTenantSignup({
      token: parsed.data.token,
    });
    if (result.ok) return reply.code(201).send(result);

    switch (result.kind) {
      case "InvalidToken":
      case "Expired":
        return reply
          .code(400)
          .send({ error: result.kind, message: result.message });
      case "AlreadyUsed":
      case "SlugTaken":
        return reply
          .code(409)
          .send({ error: result.kind, message: result.message });
      case "ModeDisabled":
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
