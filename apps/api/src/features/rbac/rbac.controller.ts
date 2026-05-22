import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  CreateUserResult,
  RbacService,
  RoleResult,
} from "./rbac.service.js";
import {
  assignSchema,
  createRoleSchema,
  createUserSchema,
  updateRoleSchema,
} from "./schemas.js";

/**
 * HTTP adapter for RBAC admin routes. Body parsing + service-result
 * → status mapping; the service holds the rules.
 */
export class RbacController {
  constructor(private readonly service: RbacService) {}

  sync = async (req: FastifyRequest) => this.service.sync(req.user.sub);

  listPermissions = async () => this.service.listPermissions();

  listPermissionHolders = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.listPermissionHolders(req.params.key);
    if (!result.ok) {
      return reply.code(404).send({
        error: "NotFound",
        message: `Permission '${req.params.key}' is not in the catalog.`,
      });
    }
    return result.payload;
  };

  listRoles = async () => this.service.listRoles();

  findRole = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const r = await this.service.findRole(req.params.key);
    if (!r) return reply.code(404).send({ error: "NotFound" });
    return r;
  };

  createRole = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.createRole({
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapRoleError(result, reply);
    return reply.code(201).send(result.role);
  };

  updateRole = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return this.service.updateRole({
      key: req.params.key,
      input: parsed.data,
      actorId: req.user.sub,
    });
  };

  deleteRole = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.deleteRole({
      key: req.params.key,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return result.role;
  };

  listUsers = async () => this.service.listUsers();

  listUserRoles = async (req: FastifyRequest<{ Params: { userId: string } }>) =>
    this.service.listUserRoles(req.params.userId);

  createUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.createUser({
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapCreateUserError(result, reply);
    return reply.code(201).send(result.user);
  };

  assignRole = async (
    req: FastifyRequest<{ Params: { userId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.assignRole({
      userId: req.params.userId,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return reply.code(201).send(result.assignment);
  };

  unassignRole = async (
    req: FastifyRequest<{ Params: { userId: string; roleKey: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.unassignRole({
      userId: req.params.userId,
      roleKey: req.params.roleKey,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return { ok: true };
  };

  // ─── error mapping ────────────────────────────────────────────────

  private mapRoleError(
    result: Extract<RoleResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    if (result.kind === "Conflict") {
      return reply
        .code(409)
        .send({ error: "Conflict", message: result.message });
    }
    return reply
      .code(400)
      .send({ error: "BadRequest", message: result.message });
  }

  private mapCreateUserError(
    result: Extract<CreateUserResult, { ok: false }>,
    reply: FastifyReply,
  ) {
    switch (result.kind) {
      case "Conflict":
      case "CustomerLinked":
        return reply
          .code(409)
          .send({ error: "Conflict", message: result.message });
      case "CustomerNotFound":
        return reply
          .code(404)
          .send({ error: "NotFound", message: result.message });
    }
  }
}
