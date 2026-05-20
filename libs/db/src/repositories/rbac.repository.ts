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

import {
  DEFAULT_ROLES,
  PERMISSIONS,
  PERMISSION_KEYS,
} from '@loan/auth';
import type {
  Permission,
  PrismaClient,
  Role,
  UserRoleAssignment,
} from '@prisma/client';

export class PermissionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: [{ category: 'asc' }, { key: 'asc' }] });
  }

  /** Idempotent: upsert one row per code-defined permission. */
  async seed(): Promise<{ created: number; existing: number }> {
    let created = 0;
    let existing = 0;
    for (const p of PERMISSIONS) {
      const found = await this.prisma.permission.findUnique({ where: { key: p.key } });
      if (found) {
        // Keep labels in sync if the code definition has been updated.
        if (found.label !== p.label || found.category !== p.category || found.description !== (p.description ?? null)) {
          await this.prisma.permission.update({
            where: { id: found.id },
            data: { label: p.label, category: p.category, description: p.description ?? null },
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

  list(): Promise<Array<Role & { permissions: { permission: Permission }[]; _count: { users: number } }>> {
    return this.prisma.role.findMany({
      orderBy: { key: 'asc' },
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: true } },
      },
    });
  }

  findByKey(key: string): Promise<Role | null> {
    return this.prisma.role.findUnique({ where: { key } });
  }

  async findByKeyWithPermissions(
    key: string,
  ): Promise<(Role & { permissions: { permission: Permission }[] }) | null> {
    return this.prisma.role.findUnique({
      where: { key },
      include: { permissions: { include: { permission: true } } },
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
    if (role.system) throw new Error('System roles cannot be deleted.');
    return this.prisma.role.delete({ where: { id: role.id } });
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

  listAssignmentsForUser(userId: string): Promise<Array<UserRoleAssignment & { role: Role }>> {
    return this.prisma.userRoleAssignment.findMany({
      where: { userId },
      include: { role: true },
      orderBy: { grantedAt: 'asc' },
    });
  }

  async assign(userId: string, roleKey: string, grantedById: string): Promise<UserRoleAssignment> {
    const role = await this.findByKey(roleKey);
    if (!role) throw new Error(`Role ${roleKey} not found`);
    return this.prisma.userRoleAssignment.upsert({
      where: { userId_roleId: { userId, roleId: role.id } },
      create: { userId, roleId: role.id, grantedById },
      update: {}, // already assigned — no-op
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
    const users = await this.prisma.user.findMany({ select: { id: true, role: true } });
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
 * every role they've been assigned. Used by the requirePermission middleware.
 */
export async function resolveUserPermissions(
  prisma: PrismaClient,
  userId: string,
): Promise<Set<string>> {
  const rows = await prisma.userRoleAssignment.findMany({
    where: { userId },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
    },
  });
  const keys = new Set<string>();
  for (const a of rows) {
    for (const rp of a.role.permissions) {
      keys.add(rp.permission.key);
    }
  }
  return keys;
}
