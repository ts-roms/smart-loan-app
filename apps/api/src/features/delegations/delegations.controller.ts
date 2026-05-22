import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  CreateResult,
  DelegationService,
  ExtendResult,
  RevokeResult,
} from "./delegations.service.js";
import { createSchema, extendSchema, revokeSchema } from "./schemas.js";

/**
 * HTTP adapter for delegations. Caller permissions are resolved here
 * (off the request) and handed to the service — keeps the service from
 * having to know about `req.permissions` or its fallback path.
 */
export class DelegationController {
  constructor(
    private readonly service: DelegationService,
    private readonly resolveCallerPerms: (
      req: FastifyRequest,
    ) => Promise<Set<string>>,
  ) {}

  userDirectory = async () => this.service.userDirectory();

  listMine = async (req: FastifyRequest) =>
    this.service.listForCaller(req.user.sub);

  listAll = async () => this.service.listAll();

  listActive = async (req: FastifyRequest) =>
    this.service.listActiveFor(req.user.sub);

  preview = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const callerPerms = await this.resolveCallerPerms(req);
    const result = await this.service.previewResolvedPermissions({
      id: req.params.id,
      callerId: req.user.sub,
      callerPerms,
    });
    if (!result.ok) {
      if (result.kind === "NotFound") {
        return reply.code(404).send({ error: "NotFound" });
      }
      return reply
        .code(403)
        .send({ error: "Forbidden", message: result.message });
    }
    return result.payload;
  };

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const callerPerms = await this.resolveCallerPerms(req);
    const result = await this.service.create({
      callerId: req.user.sub,
      callerPerms,
      input: parsed.data,
    });
    if (!result.ok) return this.mapCreateError(result, reply);
    return reply.code(201).send(result.delegation);
  };

  revoke = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = revokeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const callerPerms = await this.resolveCallerPerms(req);
    const result = await this.service.revoke({
      id: req.params.id,
      callerId: req.user.sub,
      callerPerms,
      input: parsed.data,
    });
    if (!result.ok) return this.mapRevokeError(result, reply);
    return result.delegation;
  };

  extend = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = extendSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const callerPerms = await this.resolveCallerPerms(req);
    const result = await this.service.extend({
      id: req.params.id,
      callerId: req.user.sub,
      callerPerms,
      input: parsed.data,
    });
    if (!result.ok) return this.mapExtendError(result, reply);
    return result.delegation;
  };

  // ─── error mapping ────────────────────────────────────────────────

  private mapCreateError(
    result: Extract<CreateResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    switch (result.kind) {
      case "ForbiddenDelegator":
      case "MissingPermissions":
        return reply
          .code(403)
          .send({ error: "Forbidden", message: result.message });
      case "RepoError":
      default:
        return reply
          .code(400)
          .send({ error: "BadRequest", message: result.message });
    }
  }

  private mapRevokeError(
    result: Extract<RevokeResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    if (result.kind === "NotFound") {
      return reply.code(404).send({ error: "NotFound" });
    }
    return reply
      .code(403)
      .send({ error: "Forbidden", message: result.message });
  }

  private mapExtendError(
    result: Extract<ExtendResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    switch (result.kind) {
      case "NotFound":
        return reply.code(404).send({ error: "NotFound" });
      case "Forbidden":
        return reply
          .code(403)
          .send({ error: "Forbidden", message: result.message });
      case "AlreadyRevoked":
        return reply
          .code(409)
          .send({ error: "Conflict", message: result.message });
      case "NotAfterCurrent":
        return reply
          .code(400)
          .send({ error: "BadRequest", message: result.message });
    }
  }
}
