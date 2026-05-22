/**
 * RBAC persistence — permissions catalog + roles + assignments.
 *
 *   - PermissionRepository: read-only listing + idempotent seed of the
 *     code-defined catalog.
 *   - RoleRepository: full CRUD + permission set management. Custom roles
 *     can be added at runtime; system roles can be edited but not deleted.
 *   - resolveUserPermissions: cheap union query — returns the flat set of
 *     permission keys a user holds across all their assigned roles.
 */

import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_KEYS } from "@loan/auth";
import type {
  Permission,
  PrismaClient,
  Role,
  UserRoleAssignment,
} from "@prisma/client";

export class PermissionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<Permission[]> {
    return this.prisma.permission.findMany({
      orderBy: [{ category: "asc" }, { key: "asc" }],
    });
  }

  /**
   * Update the lifecycle status of a permission. The status is the only
   * field this method touches; labels/category come from the code seed
   * and stay authoritative there.
   */
  setStatus(
    key: string,
    status: "DRAFT" | "ACTIVE" | "DEPRECATED",
  ): Promise<Permission> {
    return this.prisma.permission.update({
      where: { key },
      data: { status },
    });
  }

  /** Idempotent: upsert one row per code-defined permission. */
  async seed(): Promise<{ created: number; existing: number }> {
    let created = 0;
    let existing = 0;
    for (const p of PERMISSIONS) {
      const found = await this.prisma.permission.findUnique({
        where: { key: p.key },
      });
      if (found) {
        // Keep labels in sync if the code definition has been updated.
        if (
          found.label !== p.label ||
          found.category !== p.category ||
          found.description !== (p.description ?? null)
        ) {
          await this.prisma.permission.update({
            where: { id: found.id },
            data: {
              label: p.label,
              category: p.category,
              description: p.description ?? null,
            },
          });
        }
        existing += 1;
        continue;
      }
      await this.prisma.permission.create({
        data: {
          key: p.key,
          label: p.label,
          description: p.description,
          category: p.category,
          system: true,
        },
      });
      created += 1;
    }
    return { created, existing };
  }
}

export interface RoleCreateInput {
  key: string;
  name: string;
  description?: string;
  permissions?: string[];
}

export interface RoleUpdateInput {
  name?: string;
  description?: string;
  permissions?: string[];
}

export class RoleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<
    Array<
      Role & {
        permissions: { permission: Permission }[];
        parents: { parent: Role }[];
        _count: { users: number };
      }
    >
  > {
    return this.prisma.role.findMany({
      orderBy: { key: "asc" },
      include: {
        permissions: { include: { permission: true } },
        parents: { include: { parent: true } },
        _count: { select: { users: true } },
      },
    });
  }

  findByKey(key: string): Promise<Role | null> {
    return this.prisma.role.findUnique({ where: { key } });
  }

  async findByKeyWithPermissions(key: string): Promise<
    | (Role & {
        permissions: { permission: Permission }[];
        parents: { parent: Role }[];
      })
    | null
  > {
    return this.prisma.role.findUnique({
      where: { key },
      include: {
        permissions: { include: { permission: true } },
        parents: { include: { parent: true } },
      },
    });
  }

  async create(input: RoleCreateInput): Promise<Role> {
    const role = await this.prisma.role.create({
      data: {
        key: input.key,
        name: input.name,
        description: input.description,
        system: false,
      },
    });
    if (input.permissions?.length) {
      await this.setPermissions(role.key, input.permissions);
    }
    return role;
  }

  async update(key: string, input: RoleUpdateInput): Promise<Role> {
    const role = await this.findByKey(key);
    if (!role) throw new Error(`Role ${key} not found`);
    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: {
        name: input.name ?? role.name,
        description: input.description ?? role.description,
      },
    });
    if (input.permissions) {
      await this.setPermissions(key, input.permissions);
    }
    return updated;
  }

  async delete(key: string): Promise<Role> {
    const role = await this.findByKey(key);
    if (!role) throw new Error(`Role ${key} not found`);
    if (role.system) throw new Error("System roles cannot be deleted.");
    return this.prisma.role.delete({ where: { id: role.id } });
  }

  // ─── Inheritance ────────────────────────────────────────────────────

  /**
   * Replace the parent set of `childKey` with the roles named by
   * `parentKeys`. Rejects cycles by walking from each proposed parent
   * upward and checking that `childKey` isn't reachable — if it is,
   * adding the edge would create a loop in the inheritance graph and
   * `resolveUserPermissions` would happily infinite-loop without its
   * visited-set guard.
   *
   * Returns `{ ok: false, cycle: [...keys] }` when the proposed graph
   * would cycle so the caller can surface a useful error.
   */
  async setParents(
    childKey: string,
    parentKeys: string[],
  ): Promise<{ ok: true } | { ok: false; cycle: string[] }> {
    const child = await this.findByKey(childKey);
    if (!child) throw new Error(`Role ${childKey} not found`);
    const filteredKeys = parentKeys.filter((k) => k !== childKey);
    const parents = filteredKeys.length
      ? await this.prisma.role.findMany({
          where: { key: { in: filteredKeys } },
        })
      : [];
    const parentIds = parents.map((p) => p.id);

    // Cycle check: would adding any of these edges create a path from
    // child → ... → child? Equivalently: is child reachable when we
    // BFS from each proposed parent through the existing graph?
    if (parentIds.length > 0) {
      const cyclePath = await this.findCycleIfAdded(child.id, parentIds);
      if (cyclePath) {
        return { ok: false, cycle: cyclePath };
      }
    }

    await this.prisma.$transaction([
      this.prisma.roleInheritance.deleteMany({ where: { childId: child.id } }),
      this.prisma.roleInheritance.createMany({
        data: parentIds.map((parentId) => ({ childId: child.id, parentId })),
      }),
    ]);
    return { ok: true };
  }

  /**
   * Return the immediate parents of a role (does not transitively
   * expand). The resolver does the full expansion at permission-check
   * time; this helper is for editor UIs and audit payloads.
   */
  listParents(childKey: string): Promise<Role[]> {
    return this.prisma.role
      .findUnique({
        where: { key: childKey },
        select: {
          parents: { include: { parent: true } },
        },
      })
      .then((row) =>
        (row?.parents ?? [])
          .map((p) => p.parent)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
  }

  /**
   * Cycle-detection helper. Returns a key-path (parent → ... → child)
   * iff adding `proposedParentIds` to `childId`'s parent set would
   * create a cycle, otherwise null.
   *
   * Implementation: for each proposed parent, BFS UP through existing
   * parent edges. If childId is reachable, that's the cycle.
   */
  private async findCycleIfAdded(
    childId: string,
    proposedParentIds: string[],
  ): Promise<string[] | null> {
    const edges = await this.prisma.roleInheritance.findMany({
      select: { childId: true, parentId: true },
    });
    const parentsByChild = new Map<string, string[]>();
    for (const e of edges) {
      const arr = parentsByChild.get(e.childId);
      if (arr) arr.push(e.parentId);
      else parentsByChild.set(e.childId, [e.parentId]);
    }

    for (const seed of proposedParentIds) {
      const cameFrom = new Map<string, string | null>();
      cameFrom.set(seed, null);
      const queue: string[] = [seed];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur === childId) {
          // Reconstruct the path seed → ... → cur (childId).
          const path: string[] = [];
          let n: string | null = cur;
          while (n !== null) {
            path.unshift(n);
            n = cameFrom.get(n) ?? null;
          }
          // Translate ids → keys for the human-readable error.
          const rows = await this.prisma.role.findMany({
            where: { id: { in: path } },
            select: { id: true, key: true },
          });
          const byId = new Map(rows.map((r) => [r.id, r.key]));
          return path.map((id) => byId.get(id) ?? id);
        }
        for (const p of parentsByChild.get(cur) ?? []) {
          if (!cameFrom.has(p)) {
            cameFrom.set(p, cur);
            queue.push(p);
          }
        }
      }
    }
    return null;
  }

  /** Replace the role's permission set with the given keys (atomic). */
  async setPermissions(key: string, permissionKeys: string[]): Promise<void> {
    const role = await this.findByKey(key);
    if (!role) throw new Error(`Role ${key} not found`);
    const validKeys = permissionKeys.filter((k) => PERMISSION_KEYS.has(k));
    const perms = await this.prisma.permission.findMany({
      where: { key: { in: validKeys } },
    });
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId: role.id } }),
      this.prisma.rolePermission.createMany({
        data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      }),
    ]);
  }

  /** Idempotent: upsert the four canonical roles + their default perm sets. */
  async seedDefaults(): Promise<{ created: number; existing: number }> {
    let created = 0;
    let existing = 0;
    for (const r of DEFAULT_ROLES) {
      const existingRole = await this.findByKey(r.key);
      if (existingRole) {
        existing += 1;
      } else {
        await this.prisma.role.create({
          data: {
            key: r.key,
            name: r.name,
            description: r.description,
            system: r.system,
          },
        });
        created += 1;
      }
      // Always reconcile the system-role permission set with code defaults.
      await this.setPermissions(r.key, r.permissions);
    }
    return { created, existing };
  }

  // ─── Assignments ────────────────────────────────────────────────────

  listAssignmentsForUser(
    userId: string,
  ): Promise<Array<UserRoleAssignment & { role: Role }>> {
    return this.prisma.userRoleAssignment.findMany({
      where: { userId },
      include: { role: true },
      orderBy: { grantedAt: "asc" },
    });
  }

  /**
   * Assign a role to a user. Idempotent — on conflict, only `expiresAt`
   * is updated. That's the legitimate "extend or convert this grant"
   * path: passing `expiresAt: null` on a re-assign promotes a temporary
   * grant to perpetual; passing a new date pushes the expiry out. We
   * deliberately do not touch `grantedById`/`grantedAt` so the audit
   * trail of the original grant is preserved.
   */
  async assign(
    userId: string,
    roleKey: string,
    grantedById: string,
    expiresAt: Date | null = null,
  ): Promise<UserRoleAssignment> {
    const role = await this.findByKey(roleKey);
    if (!role) throw new Error(`Role ${roleKey} not found`);
    return this.prisma.userRoleAssignment.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      create: { userId, roleId: role.id, grantedById, expiresAt },
      update: { expiresAt },
    });
  }

  async unassign(userId: string, roleKey: string): Promise<void> {
    const role = await this.findByKey(roleKey);
    if (!role) return;
    await this.prisma.userRoleAssignment.deleteMany({
      where: { userId, roleId: role.id },
    });
  }

  /**
   * For every existing User, ensure they're assigned to the role matching
   * their legacy `User.role` enum. Idempotent — safe to run on every boot.
   */
  async backfillFromUserRoleEnum(): Promise<{ assigned: number }> {
    const users = await this.prisma.user.findMany({
      select: { id: true, role: true },
    });
    let assigned = 0;
    for (const u of users) {
      const role = await this.findByKey(u.role);
      if (!role) continue;
      const existing = await this.prisma.userRoleAssignment.findUnique({
        where: { userId_roleId: { userId: u.id, roleId: role.id } },
      });
      if (!existing) {
        await this.prisma.userRoleAssignment.create({
          data: { userId: u.id, roleId: role.id },
        });
        assigned += 1;
      }
    }
    return { assigned };
  }
}

/**
 * Resolve the effective permission key set for a user — the union across
 * every role they've been assigned, expanded through role inheritance.
 * Used by the requirePermission middleware.
 *
 * Three filters / expansions layer on top of the direct user→role link:
 *
 *   - role assignments with `expiresAt` in the past are dropped (the
 *     row stays in the DB for audit but no longer contributes)
 *   - the resolver walks the RoleInheritance graph from each direct
 *     role and unions in every parent's permissions. Cycles are
 *     guarded by a visited set (the write path also refuses cycles,
 *     but this is belt-and-braces against legacy bad data)
 *   - permissions whose `status` is `DRAFT` are dropped — DRAFT lets
 *     an admin wire role membership in advance, then flip the perm on
 *     by setting status=ACTIVE. DEPRECATED perms still grant at runtime
 *     so in-flight workflows don't break.
 *
 * Costs ~3 round-trips: direct assignments → inheritance edges → role
 * permissions for the expanded set. The edges table is small enough
 * that this stays cheap even at 100+ roles; the postgres planner
 * happily index-only-scans it.
 */
export async function resolveUserPermissions(
  prisma: PrismaClient,
  userId: string,
): Promise<Set<string>> {
  const now = new Date();

  // 1. Direct role assignments — filtered for expiry.
  const assignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { roleId: true },
  });
  if (assignments.length === 0) return new Set();

  // 2. Expand through inheritance. Fetch every edge in one shot
  //    (table is small) and walk parents in-memory.
  const edges = await prisma.roleInheritance.findMany({
    select: { childId: true, parentId: true },
  });
  const parentsByChild = new Map<string, string[]>();
  for (const e of edges) {
    const arr = parentsByChild.get(e.childId);
    if (arr) arr.push(e.parentId);
    else parentsByChild.set(e.childId, [e.parentId]);
  }
  const visited = new Set<string>();
  const queue: string[] = assignments.map((a) => a.roleId);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const parents = parentsByChild.get(id);
    if (parents) {
      for (const p of parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
  }

  // 3. Permissions for the expanded role set.
  const rps = await prisma.rolePermission.findMany({
    where: { roleId: { in: [...visited] } },
    include: { permission: { select: { key: true, status: true } } },
  });
  const keys = new Set<string>();
  for (const rp of rps) {
    if (rp.permission.status === "DRAFT") continue;
    keys.add(rp.permission.key);
  }
  return keys;
}
