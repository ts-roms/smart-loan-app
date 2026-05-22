import { hashPassword } from "@loan/auth";
import {
  type AuditLogRepository,
  type PermissionRepository,
  type PrismaClient,
  type RoleRepository,
} from "@loan/db";

import type {
  AssignRoleInput,
  CreateRoleInput,
  CreateUserInput,
  UpdateRoleInput,
} from "./schemas.js";

/**
 * RBAC orchestration. Three reasons this earns a service:
 *
 *   1. `createUser` runs a conditional cross-row check (when role is
 *      CUSTOMER, validate the linked Customer exists and isn't already
 *      attached) and hashes the password — way too much for an inline
 *      handler.
 *   2. `unassignRole` enforces the ADMIN self-lockout rule; that
 *      belongs in code that's tested independently of HTTP plumbing.
 *   3. Every write here is audit-coupled (RBAC drift is regulator-
 *      visible) — centralising the pair eliminates "oops I forgot to
 *      log that" mistakes.
 */

type RoleRow = Awaited<ReturnType<RoleRepository["create"]>>;
type RoleWithPermissions = NonNullable<
  Awaited<ReturnType<RoleRepository["findByKeyWithPermissions"]>>
>;
/**
 * The shape `prisma.user.create({ select: ... })` returns. We pin it
 * explicitly because `Awaited<ReturnType<…>>` returns the full User
 * row, not the narrowed select.
 */
interface UserCreateRow {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  createdAt: Date;
  customerId: string | null;
}

export type RoleResult =
  | { ok: true; role: RoleRow }
  | { ok: false; kind: "Conflict" | "RepoError"; message: string };

export type RoleDeleteResult =
  | { ok: true; role: RoleRow }
  | { ok: false; kind: "RepoError"; message: string };

export type CreateUserResult =
  | { ok: true; user: UserCreateRow }
  | {
      ok: false;
      kind: "Conflict" | "CustomerNotFound" | "CustomerLinked";
      message: string;
    };

export type AssignRoleResult =
  | { ok: true; assignment: Awaited<ReturnType<RoleRepository["assign"]>> }
  | { ok: false; kind: "RepoError"; message: string };

export type UnassignRoleResult =
  | { ok: true }
  | { ok: false; kind: "SelfLockout"; message: string };

export class RbacService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionRepository,
    private readonly roles: RoleRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  // ─── catalog ──────────────────────────────────────────────────────

  /**
   * Re-sync the in-code permission catalog + canonical role permission
   * sets into the DB. Idempotent — safe to call after every deploy.
   */
  async sync(actorId: string) {
    const permResult = await this.permissions.seed();
    const roleResult = await this.roles.seedDefaults();
    await this.audit.record({
      action: "RBAC_SYNC",
      actorId,
      targetType: "System",
      targetId: "rbac",
      payload: { permissions: permResult, roles: roleResult },
    });
    return { permissions: permResult, roles: roleResult };
  }

  listPermissions() {
    return this.permissions.list();
  }

  // ─── roles ────────────────────────────────────────────────────────

  listRoles() {
    return this.roles.list();
  }

  async findRole(key: string): Promise<RoleWithPermissions | null> {
    return this.roles.findByKeyWithPermissions(key);
  }

  async createRole(args: {
    input: CreateRoleInput;
    actorId: string;
  }): Promise<RoleResult> {
    try {
      const role = await this.roles.create(args.input);
      await this.audit.record({
        action: "ROLE_CREATE",
        actorId: args.actorId,
        targetType: "Role",
        targetId: role.id,
        payload: { key: role.key, permissions: args.input.permissions },
      });
      return { ok: true, role };
    } catch (err) {
      // The repo throws on unique-key collisions — surface as 409.
      return { ok: false, kind: "Conflict", message: (err as Error).message };
    }
  }

  async updateRole(args: {
    key: string;
    input: UpdateRoleInput;
    actorId: string;
  }): Promise<RoleRow> {
    const role = await this.roles.update(args.key, args.input);
    await this.audit.record({
      action: "ROLE_UPDATE",
      actorId: args.actorId,
      targetType: "Role",
      targetId: role.id,
      payload: { key: role.key, ...args.input },
    });
    return role;
  }

  async deleteRole(args: {
    key: string;
    actorId: string;
  }): Promise<RoleDeleteResult> {
    try {
      const r = await this.roles.delete(args.key);
      await this.audit.record({
        action: "ROLE_DELETE",
        actorId: args.actorId,
        targetType: "Role",
        targetId: r.id,
        payload: { key: r.key },
      });
      return { ok: true, role: r };
    } catch (err) {
      // Repo refuses to delete system roles — surface as 400.
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  // ─── users ────────────────────────────────────────────────────────

  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        createdAt: true,
        roleAssignments: {
          include: {
            role: { select: { key: true, name: true, system: true } },
          },
        },
      },
      take: 500,
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      primaryRole: u.role,
      active: u.active,
      createdAt: u.createdAt,
      roles: u.roleAssignments.map((a) => a.role),
    }));
  }

  listUserRoles(userId: string) {
    return this.roles.listAssignmentsForUser(userId);
  }

  async createUser(args: {
    input: CreateUserInput;
    actorId: string;
  }): Promise<CreateUserResult> {
    const exists = await this.prisma.user.findUnique({
      where: { email: args.input.email },
    });
    if (exists) {
      return {
        ok: false,
        kind: "Conflict",
        message: "A user with this email already exists.",
      };
    }

    // CUSTOMER role + customerId → enforce the 1:1 invariant: Customer
    // row must exist AND not already be attached to a different User.
    if (args.input.role === "CUSTOMER" && args.input.customerId) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: args.input.customerId },
        include: { user: { select: { id: true } } },
      });
      if (!customer) {
        return {
          ok: false,
          kind: "CustomerNotFound",
          message: "Customer not found",
        };
      }
      if (customer.user) {
        return {
          ok: false,
          kind: "CustomerLinked",
          message: "This customer is already linked to a user account.",
        };
      }
    }

    const user = await this.prisma.user.create({
      data: {
        email: args.input.email,
        name: args.input.name,
        passwordHash: await hashPassword(args.input.password),
        role: args.input.role,
        customerId:
          args.input.role === "CUSTOMER" && args.input.customerId
            ? args.input.customerId
            : undefined,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        createdAt: true,
        customerId: true,
      },
    });
    await this.audit.record({
      action: "USER_CREATE",
      actorId: args.actorId,
      targetType: "User",
      targetId: user.id,
      payload: { email: user.email, role: user.role },
    });
    return { ok: true, user };
  }

  // ─── role assignments ─────────────────────────────────────────────

  async assignRole(args: {
    userId: string;
    input: AssignRoleInput;
    actorId: string;
  }): Promise<AssignRoleResult> {
    try {
      const a = await this.roles.assign(
        args.userId,
        args.input.roleKey,
        args.actorId,
      );
      await this.audit.record({
        action: "USER_ROLE_ASSIGN",
        actorId: args.actorId,
        targetType: "User",
        targetId: args.userId,
        payload: { roleKey: args.input.roleKey },
      });
      return { ok: true, assignment: a };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async unassignRole(args: {
    userId: string;
    roleKey: string;
    actorId: string;
  }): Promise<UnassignRoleResult> {
    // Self-lockout guard: nobody can strip their own ADMIN role —
    // they'd lose admin.users on the very next request and get stuck.
    // Removing ADMIN from a teammate is fine; that's how demotion works.
    if (args.userId === args.actorId && args.roleKey === "ADMIN") {
      return {
        ok: false,
        kind: "SelfLockout",
        message:
          "You cannot remove the ADMIN role from yourself. Ask another admin to do it.",
      };
    }
    await this.roles.unassign(args.userId, args.roleKey);
    await this.audit.record({
      action: "USER_ROLE_UNASSIGN",
      actorId: args.actorId,
      targetType: "User",
      targetId: args.userId,
      payload: { roleKey: args.roleKey },
    });
    return { ok: true };
  }
}
