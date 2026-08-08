import type { FastifyReply, FastifyRequest } from "fastify";

import type { CreateUserResult, RoleResult } from "./rbac.service";
import {
  assignSchema,
  createRoleSchema,
  createUserSchema,
  editImpactSchema,
  forceLogoutSchema,
  setUserActiveSchema,
  permissionPatchSchema,
  updateRoleSchema,
  userBulkImportSchema,
} from "./schemas";

/**
 * HTTP adapter for RBAC admin routes. Phase 2: stateless. Reads
 * `req.rbacServices.{rbac, bulkImport}` per call.
 */
export class RbacController {
  bulkImportUsers = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = userBulkImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.rbacServices!.bulkImport.run({
      input: parsed.data,
      actorId: req.user.sub,
    });
    return reply.code(207).send(result);
  };

  sync = async (req: FastifyRequest) =>
    req.rbacServices!.rbac.sync(req.user.sub);

  listPermissions = async (req: FastifyRequest) =>
    req.rbacServices!.rbac.listPermissions();

  patchPermission = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = permissionPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.rbacServices!.rbac.setPermissionStatus({
      key: req.params.key,
      status: parsed.data.status,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      return reply.code(404).send({
        error: "NotFound",
        message: `Permission '${req.params.key}' is not in the catalog.`,
      });
    }
    return result.permission;
  };

  computeRoleEditImpact = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = editImpactSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.rbacServices!.rbac.computeRoleEditImpact({
      roleKey: req.params.key,
      newPermissionKeys: parsed.data.permissions,
    });
    if (!result.ok) {
      return reply.code(404).send({ error: "NotFound" });
    }
    return result.payload;
  };

  listPermissionHolders = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.rbacServices!.rbac.listPermissionHolders(
      req.params.key,
    );
    if (!result.ok) {
      return reply.code(404).send({
        error: "NotFound",
        message: `Permission '${req.params.key}' is not in the catalog.`,
      });
    }
    return result.payload;
  };

  listRoles = async (req: FastifyRequest) => req.rbacServices!.rbac.listRoles();

  findRole = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const r = await req.rbacServices!.rbac.findRole(req.params.key);
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
    const result = await req.rbacServices!.rbac.createRole({
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
    const result = await req.rbacServices!.rbac.updateRole({
      key: req.params.key,
      input: parsed.data,
      actorId: req.user.sub,
    });
    if (!result.ok) return this.mapRoleError(result, reply);
    return result.role;
  };

  deleteRole = async (
    req: FastifyRequest<{ Params: { key: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.rbacServices!.rbac.deleteRole({
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

  listUsers = async (req: FastifyRequest) => req.rbacServices!.rbac.listUsers();

  listUserRoles = async (req: FastifyRequest<{ Params: { userId: string } }>) =>
    req.rbacServices!.rbac.listUserRoles(req.params.userId);

  createUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.rbacServices!.rbac.createUser({
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
    const result = await req.rbacServices!.rbac.assignRole({
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
    const result = await req.rbacServices!.rbac.unassignRole({
      userId: req.params.userId,
      roleKey: req.params.roleKey,
      actorId: req.user.sub,
    });
    if (!result.ok) {
      if (result.kind === "LastAdmin") {
        return reply
          .code(409)
          .send({ error: "Conflict", message: result.message });
      }
      return reply
        .code(400)
        .send({ error: "BadRequest", message: result.message });
    }
    return { ok: true };
  };

  setUserActive = async (
    req: FastifyRequest<{ Params: { userId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = setUserActiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.rbacServices!.rbac.setUserActive({
      userId: req.params.userId,
      active: parsed.data.active,
      actorId: req.user.sub,
      reason: parsed.data.reason,
    });
    if (!result.ok) {
      if (result.kind === "NotFound") {
        return reply
          .code(404)
          .send({ error: "NotFound", message: result.message });
      }
      // Self and LastAdmin are both well-formed requests refused on the
      // state of the org, which is what 409 is for.
      return reply
        .code(409)
        .send({ error: result.kind, message: result.message });
    }
    return {
      ok: true,
      userId: result.userId,
      email: result.email,
      name: result.name,
      active: result.active,
      revokedAt: result.revokedAt?.toISOString() ?? null,
      refreshTokensRevoked: result.refreshTokensRevoked,
    };
  };

  forceLogout = async (
    req: FastifyRequest<{ Params: { userId: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = forceLogoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.rbacServices!.rbac.forceLogout({
      userId: req.params.userId,
      actorId: req.user.sub,
      reason: parsed.data.reason,
    });
    if (!result.ok) {
      if (result.kind === "NotFound") {
        return reply
          .code(404)
          .send({ error: "NotFound", message: result.message });
      }
      // Self-targeting. 409 rather than 400: the request is well-formed
      // and would have worked against any other row.
      return reply
        .code(409)
        .send({ error: "Conflict", message: result.message });
    }
    return {
      ok: true,
      userId: result.userId,
      email: result.email,
      name: result.name,
      revokedAt: result.revokedAt.toISOString(),
      refreshTokensRevoked: result.refreshTokensRevoked,
    };
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
    if (result.kind === "Cycle") {
      return reply
        .code(400)
        .send({ error: "InheritanceCycle", message: result.message });
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
