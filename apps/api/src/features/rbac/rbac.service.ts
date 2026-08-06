import { hashPassword } from "@loan/auth";
import {
  type AuditLogRepository,
  type NotificationRepository,
  type PermissionRepository,
  type PrismaClient,
  resolveUserPermissions,
  type RoleRepository,
} from "@loan/db";
import type { FastifyBaseLogger } from "fastify";

import type {
  AssignRoleInput,
  CreateRoleInput,
  CreateUserInput,
  UpdateRoleInput,
} from "./schemas";

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
  | { ok: false; kind: "Conflict" | "RepoError" | "Cycle"; message: string };

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
  | { ok: false; kind: "RepoError" | "BadExpiry"; message: string };

export type ForceLogoutResult =
  | {
      ok: true;
      userId: string;
      email: string;
      name: string;
      /** When the cutoff was set. Every token issued at or before this dies. */
      revokedAt: Date;
      /** Refresh tokens killed alongside it. Zero is normal and fine. */
      refreshTokensRevoked: number;
    }
  | {
      ok: false;
      kind: "NotFound" | "Self";
      message: string;
    };

export type UnassignRoleResult =
  | { ok: true }
  | {
      ok: false;
      kind: "SelfLockout" | "LastAdmin";
      message: string;
    };

/**
 * Shape returned by `listPermissionHolders` — the reverse-lookup
 * answer to "who currently has permission X?". Splits the answer into
 * the two grant paths (direct role membership vs active delegation)
 * so the UI can show both and explain provenance.
 */
export interface PermissionHolderDelegation {
  id: string;
  delegatorId: string;
  delegatorName: string;
  delegateId: string;
  delegateName: string;
  startsAt: Date;
  endsAt: Date;
  /**
   * `true` when the delegation explicitly listed this permission key;
   * `false` when the delegation has an empty `permissions[]` ("all of
   * the delegator's permissions") and the delegator happens to hold
   * this key right now. The latter is fragile — if the delegator
   * loses the key, the delegation silently drops it too.
   */
  viaExplicit: boolean;
}

export interface PermissionHoldersPayload {
  permission: {
    key: string;
    label: string;
    description: string | null;
    category: string;
  };
  directRoles: Array<{
    key: string;
    name: string;
    system: boolean;
    userCount: number;
  }>;
  delegations: PermissionHolderDelegation[];
  totalActiveUsers: number;
}

export type ListPermissionHoldersResult =
  | { ok: true; payload: PermissionHoldersPayload }
  | { ok: false; kind: "NotFound" };

/**
 * Shape returned by `computeRoleEditImpact` — the safety-net answer to
 * "if I save this role with these permissions, who loses what?". The
 * heavy lift is computing the per-permission user count: a user only
 * "loses" a permission if no OTHER role they hold grants the same
 * key. Users with overlapping role membership won't show up here.
 *
 * Delegation knock-on (empty-permissions delegations whose delegator
 * loses a perm) is intentionally NOT included — discoverable via the
 * separate `/admin/permissions/:key/holders` endpoint after the save.
 * Bundling it here would double the query count for a marginal gain.
 */
export interface RoleEditImpactPayload {
  role: { key: string; name: string; system: boolean };
  /**
   * Permissions present on the current role but absent from the
   * proposed update. Each entry's `usersLosing` is the count of
   * active users for whom this role is the *only* grant.
   */
  removed: Array<{
    key: string;
    label: string;
    usersLosing: number;
  }>;
  /** Keys being newly added by the proposed update. No risk count;
   * adding permissions is additive. */
  addedKeys: string[];
}

export type RoleEditImpactResult =
  | { ok: true; payload: RoleEditImpactPayload }
  | { ok: false; kind: "NotFound" };

export class RbacService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly permissions: PermissionRepository,
    private readonly roles: RoleRepository,
    private readonly audit: AuditLogRepository,
    private readonly notifications: NotificationRepository,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Notify a user that their role assignment changed. Best-effort
   * dispatch — same schema-reality caveat as DelegationService:
   * email only (no phone column on User, no user-scoped Notification
   * rows). Failure must not roll back the role write — the caller
   * wraps this in .catch().
   */
  private async notifyRoleChange(args: {
    userId: string;
    roleKey: string;
    change: "added" | "removed";
  }): Promise<void> {
    const [user, role] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: args.userId },
        select: { name: true, email: true },
      }),
      this.prisma.role.findUnique({
        where: { key: args.roleKey },
        select: { name: true },
      }),
    ]);
    if (!user || !user.email) return;
    await this.notifications.dispatch({
      event: "USER_ROLE_CHANGED",
      channel: "EMAIL",
      recipient: user.email,
      data: {
        recipientName: user.name,
        roleName: role?.name ?? args.roleKey,
        change: args.change,
      },
      refType: "User",
      refId: args.userId,
    });
  }

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

  /**
   * Flip a permission's lifecycle status. Audit-coupled — the actor +
   * the from/to states are recorded. Service swallows the repo
   * not-found error and returns a typed result.
   *
   *   - DRAFT      → resolver stops granting (effective lockout)
   *   - ACTIVE     → resolver grants normally
   *   - DEPRECATED → resolver still grants but UI flags it for cleanup
   */
  async setPermissionStatus(args: {
    key: string;
    status: "DRAFT" | "ACTIVE" | "DEPRECATED";
    actorId: string;
  }): Promise<
    | {
        ok: true;
        permission: Awaited<ReturnType<PermissionRepository["setStatus"]>>;
      }
    | { ok: false; kind: "NotFound" }
  > {
    const existing = await this.prisma.permission.findUnique({
      where: { key: args.key },
      select: { status: true },
    });
    if (!existing) return { ok: false, kind: "NotFound" };
    const permission = await this.permissions.setStatus(args.key, args.status);
    await this.audit.record({
      action: "PERMISSION_STATUS_CHANGE",
      actorId: args.actorId,
      targetType: "Permission",
      targetId: permission.id,
      payload: {
        key: args.key,
        from: existing.status,
        to: args.status,
      },
    });
    return { ok: true, permission };
  }

  /**
   * Reverse lookup: "who currently holds permission X?". Returns the
   * two grant paths separately:
   *
   *   - direct roles that include the permission (with user counts)
   *   - active delegations (`startsAt ≤ now ≤ endsAt`, not revoked)
   *     that grant the permission — either by listing it explicitly
   *     OR by being an "all of my perms" delegation (`permissions[]`
   *     empty) where the delegator currently holds the key
   *
   * The second case requires a per-delegator perm resolve, so we
   * cache by delegatorId to avoid N+1 when the same delegator has
   * multiple open delegations.
   */
  async listPermissionHolders(
    key: string,
  ): Promise<ListPermissionHoldersResult> {
    const permission = await this.prisma.permission.findUnique({
      where: { key },
      select: { key: true, label: true, description: true, category: true },
    });
    if (!permission) return { ok: false, kind: "NotFound" };

    // Roles directly granting this permission, each with its user count.
    const rolePerms = await this.prisma.rolePermission.findMany({
      where: { permission: { key } },
      include: {
        role: {
          select: {
            key: true,
            name: true,
            system: true,
            _count: { select: { users: true } },
          },
        },
      },
    });
    const directRoles = rolePerms
      .map((rp) => ({
        key: rp.role.key,
        name: rp.role.name,
        system: rp.role.system,
        userCount: rp.role._count.users,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Active delegation candidates. Two ways to grant:
    //   (a) explicit  — `permissions[]` contains the key
    //   (b) inherited — `permissions[]` is empty AND delegator
    //                   currently holds the key
    // We fetch both shapes in one query, then filter (b) via the
    // permission resolver.
    const now = new Date();
    const activeBase = {
      revokedAt: null,
      startsAt: { lte: now },
      endsAt: { gte: now },
    };
    const candidates = await this.prisma.delegation.findMany({
      where: {
        ...activeBase,
        OR: [{ permissions: { has: key } }, { permissions: { isEmpty: true } }],
      },
      include: {
        delegator: { select: { name: true } },
        delegate: { select: { name: true } },
      },
    });

    const delegatorPermCache = new Map<string, Set<string>>();
    const delegations: PermissionHolderDelegation[] = [];
    for (const d of candidates) {
      const viaExplicit = d.permissions.includes(key);
      let included = viaExplicit;
      if (!included && d.permissions.length === 0) {
        let perms = delegatorPermCache.get(d.delegatorId);
        if (!perms) {
          perms = await resolveUserPermissions(this.prisma, d.delegatorId);
          delegatorPermCache.set(d.delegatorId, perms);
        }
        included = perms.has(key);
      }
      if (!included) continue;
      delegations.push({
        id: d.id,
        delegatorId: d.delegatorId,
        delegatorName: d.delegator.name,
        delegateId: d.delegateId,
        delegateName: d.delegate.name,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        viaExplicit,
      });
    }

    // Unique active users = users with one of the listed roles
    // UNION delegates of the active delegations granting this perm.
    // We dedup so the count reflects distinct people, not assignments.
    const usersWithDirectRole = await this.prisma.userRoleAssignment.findMany({
      where: { role: { permissions: { some: { permission: { key } } } } },
      select: { userId: true },
      distinct: ["userId"],
    });
    const totalActiveUsers = new Set([
      ...usersWithDirectRole.map((u) => u.userId),
      ...delegations.map((d) => d.delegateId),
    ]).size;

    return {
      ok: true,
      payload: {
        permission,
        directRoles,
        delegations,
        totalActiveUsers,
      },
    };
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
      // Apply inheritance edges if supplied. A new role has no
      // existing edges so a cycle is impossible unless one of the
      // proposed parents already inherits from this key — the
      // setParents call still walks the graph defensively.
      if (args.input.parents && args.input.parents.length > 0) {
        const parentResult = await this.roles.setParents(
          role.key,
          args.input.parents,
        );
        if (!parentResult.ok) {
          // Roll back the newly-created role so the user can re-try
          // with a different parent set without a phantom row.
          await this.roles.delete(role.key).catch(() => {});
          return {
            ok: false,
            kind: "Cycle",
            message: `Adding those parents would create an inheritance cycle: ${parentResult.cycle.join(" → ")}`,
          };
        }
      }
      await this.audit.record({
        action: "ROLE_CREATE",
        actorId: args.actorId,
        targetType: "Role",
        targetId: role.id,
        payload: {
          key: role.key,
          permissions: args.input.permissions,
          parents: args.input.parents,
        },
      });
      return { ok: true, role };
    } catch (err) {
      // The repo throws on unique-key collisions — surface as 409.
      return { ok: false, kind: "Conflict", message: (err as Error).message };
    }
  }

  /**
   * Compute the downstream impact of editing a role's permission list.
   * Returns the diff plus, for each removed permission, how many
   * active users would lose it (no other role they hold grants the
   * same key). The dialog UI calls this before the actual save to
   * warn the admin "you're about to take loans.decide away from 12
   * people via this role" — much better than discovering it after.
   */
  async computeRoleEditImpact(args: {
    roleKey: string;
    newPermissionKeys: string[];
  }): Promise<RoleEditImpactResult> {
    const role = await this.prisma.role.findUnique({
      where: { key: args.roleKey },
      include: {
        permissions: {
          include: {
            permission: {
              select: { key: true, label: true },
            },
          },
        },
      },
    });
    if (!role) return { ok: false, kind: "NotFound" };

    const currentKeyToLabel = new Map(
      role.permissions.map((rp) => [rp.permission.key, rp.permission.label]),
    );
    const newKeys = new Set(args.newPermissionKeys);
    const removedKeys = [...currentKeyToLabel.keys()].filter(
      (k) => !newKeys.has(k),
    );
    const addedKeys = args.newPermissionKeys.filter(
      (k) => !currentKeyToLabel.has(k),
    );

    // Per-permission: count active users for whom this role is the
    // sole grant. The NOT…some pattern eliminates users with at least
    // one other role granting the same key — those users aren't
    // affected by removing the perm from THIS role.
    const removed: RoleEditImpactPayload["removed"] = [];
    for (const key of removedKeys) {
      const usersLosing = await this.prisma.user.count({
        where: {
          active: true,
          roleAssignments: { some: { roleId: role.id } },
          NOT: {
            roleAssignments: {
              some: {
                roleId: { not: role.id },
                role: {
                  permissions: { some: { permission: { key } } },
                },
              },
            },
          },
        },
      });
      removed.push({
        key,
        label: currentKeyToLabel.get(key) ?? key,
        usersLosing,
      });
    }

    return {
      ok: true,
      payload: {
        role: { key: role.key, name: role.name, system: role.system },
        removed,
        addedKeys,
      },
    };
  }

  async updateRole(args: {
    key: string;
    input: UpdateRoleInput;
    actorId: string;
  }): Promise<RoleResult> {
    // Apply parents BEFORE the main update so we can fail fast on
    // cycle detection without having mutated the role's other fields.
    if (args.input.parents !== undefined) {
      const parentResult = await this.roles.setParents(
        args.key,
        args.input.parents,
      );
      if (!parentResult.ok) {
        return {
          ok: false,
          kind: "Cycle",
          message: `Adding those parents would create an inheritance cycle: ${parentResult.cycle.join(" → ")}`,
        };
      }
    }
    try {
      // Pull `parents` out — the repo's update path doesn't know about
      // inheritance and would just ignore it, but stripping is honest.
      const { parents: _ignored, ...rest } = args.input;
      void _ignored;
      const role = await this.roles.update(args.key, rest);
      await this.audit.record({
        action: "ROLE_UPDATE",
        actorId: args.actorId,
        targetType: "Role",
        targetId: role.id,
        payload: { key: role.key, ...args.input },
      });
      return { ok: true, role };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
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
          select: {
            expiresAt: true,
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
      // Flatten + carry expiry. Note expired assignments are still
      // returned — the resolver filters them out at permission-check
      // time, but the UI wants to show "expired 3 days ago" for
      // visibility, not pretend the row doesn't exist.
      roles: u.roleAssignments.map((a) => ({
        key: a.role.key,
        name: a.role.name,
        system: a.role.system,
        expiresAt: a.expiresAt?.toISOString() ?? null,
      })),
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

  /**
   * End every session a user currently has — staff or borrower alike.
   *
   * Two writes, and both are needed. Stamping `sessionsRevokedAt`
   * invalidates the access tokens already in the wild, which is the
   * half that takes effect immediately; revoking the refresh tokens
   * stops the client quietly minting a fresh one a moment later. Doing
   * only the first buys seconds, and doing only the second buys
   * nothing at all for up to 24 hours.
   *
   * They go in one transaction because a partial application is a
   * silent failure: the caller is told the session ended and it didn't.
   *
   * This does NOT disable the account. The user can sign in again
   * straight away with the same password, which is the right default —
   * "log this stolen laptop out" and "this person no longer works here"
   * are different decisions, and conflating them means every session
   * reset becomes an offboarding. Deactivation already exists
   * separately, and now that `authenticate` checks `active`, it takes
   * effect immediately too.
   */
  async forceLogout(args: {
    userId: string;
    actorId: string;
    reason?: string;
  }): Promise<ForceLogoutResult> {
    /*
     * Refusing to target yourself.
     *
     * Not a security boundary — an admin who wants out can sign out,
     * and could force-logout their own account through a second admin
     * anyway. It's here because the failure is silent and confusing:
     * the request succeeds, the response never arrives at a live
     * session, and the admin is bounced to the login screen with no
     * explanation, having probably meant to click the row above.
     */
    if (args.userId === args.actorId) {
      return {
        ok: false,
        kind: "Self",
        message:
          "You can't end your own sessions here — use Sign out. To reset another admin, ask them or use a second admin account.",
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: args.userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      return { ok: false, kind: "NotFound", message: "User not found" };
    }

    const revokedAt = new Date();
    const refreshTokensRevoked = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { sessionsRevokedAt: revokedAt },
      });
      const { count } = await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt },
      });
      return count;
    });

    await this.audit.record({
      action: "SESSIONS_REVOKED",
      actorId: args.actorId,
      targetType: "User",
      targetId: user.id,
      // The reason is the whole value of this row six months later.
      // Without it the trail says an admin cut someone off and nothing
      // about why, which is exactly the question an auditor asks.
      payload: {
        email: user.email,
        revokedAt: revokedAt.toISOString(),
        refreshTokensRevoked,
        reason: args.reason ?? null,
      },
    });

    return {
      ok: true,
      userId: user.id,
      email: user.email,
      name: user.name,
      revokedAt,
      refreshTokensRevoked,
    };
  }

  // ─── role assignments ─────────────────────────────────────────────

  async assignRole(args: {
    userId: string;
    input: AssignRoleInput;
    actorId: string;
  }): Promise<AssignRoleResult> {
    // Parse + sanity-check the optional expiry. Past dates are
    // rejected — recording a "born expired" grant has no semantic
    // value and would make the audit trail confusing.
    let expiresAt: Date | null = null;
    if (args.input.expiresAt) {
      const parsed = new Date(args.input.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return {
          ok: false,
          kind: "BadExpiry",
          message: "expiresAt must be a valid ISO-8601 timestamp.",
        };
      }
      if (parsed.getTime() <= Date.now()) {
        return {
          ok: false,
          kind: "BadExpiry",
          message: "expiresAt must be in the future.",
        };
      }
      expiresAt = parsed;
    }

    try {
      const a = await this.roles.assign(
        args.userId,
        args.input.roleKey,
        args.actorId,
        expiresAt,
      );
      await this.audit.record({
        action: "USER_ROLE_ASSIGN",
        actorId: args.actorId,
        targetType: "User",
        targetId: args.userId,
        payload: {
          roleKey: args.input.roleKey,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      });
      // Best-effort email to the user whose access just changed.
      // Failure can't roll back the assignment.
      await this.notifyRoleChange({
        userId: args.userId,
        roleKey: args.input.roleKey,
        change: "added",
      }).catch((err) =>
        this.log.warn(
          { err, userId: args.userId, roleKey: args.input.roleKey },
          "USER_ROLE_CHANGED (added) notification dispatch failed",
        ),
      );
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

    // Last-admin guard: an admin removing another admin is fine UNTIL
    // it would leave the org with zero active admins. The
    // self-lockout above doesn't cover this case — e.g. Alice (admin)
    // removes Bob's ADMIN when Bob was the only other admin. The
    // org then has only Alice; if her account is later disabled,
    // nobody can rescue it. Refuse pre-emptively.
    if (args.roleKey === "ADMIN") {
      const now = new Date();
      const remainingActiveAdmins = await this.prisma.userRoleAssignment.count({
        where: {
          role: { key: "ADMIN" },
          user: { active: true },
          // Don't double-count the user about to lose their ADMIN.
          userId: { not: args.userId },
          // Expired admin grants don't count as "rescue" — they're
          // already inactive at the resolver level. A row with
          // expiresAt < now is functionally identical to no row at all.
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });
      if (remainingActiveAdmins === 0) {
        return {
          ok: false,
          kind: "LastAdmin",
          message:
            "Cannot remove ADMIN — this is the last active admin on the org. Promote another user to ADMIN first.",
        };
      }
    }

    await this.roles.unassign(args.userId, args.roleKey);
    await this.audit.record({
      action: "USER_ROLE_UNASSIGN",
      actorId: args.actorId,
      targetType: "User",
      targetId: args.userId,
      payload: { roleKey: args.roleKey },
    });
    // Best-effort email — same caveat as assignRole.
    await this.notifyRoleChange({
      userId: args.userId,
      roleKey: args.roleKey,
      change: "removed",
    }).catch((err) =>
      this.log.warn(
        { err, userId: args.userId, roleKey: args.roleKey },
        "USER_ROLE_CHANGED (removed) notification dispatch failed",
      ),
    );
    return { ok: true };
  }
}
