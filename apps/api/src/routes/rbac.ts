/**
 * RBAC admin: permission catalog, role CRUD, user role assignments.
 *
 * All routes guarded by `admin.roles` (most) or `admin.users` (assignment).
 * The four canonical roles can be edited but not deleted; their `system`
 * flag is enforced at the repository layer.
 */

import {
  AuditLogRepository,
  PermissionRepository,
  RoleRepository,
} from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const roleKeySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]+$/, 'Key must be UPPER_SNAKE_CASE');

const createRoleSchema = z.object({
  key: roleKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(200).optional(),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(200).optional(),
});

const assignSchema = z.object({
  roleKey: z.string().min(1),
});

export async function rbacRoutes(app: FastifyInstance) {
  const permissions = new PermissionRepository(app.prisma);
  const roles = new RoleRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  /**
   * Re-sync the in-code permission catalog + canonical role permission
   * sets into the DB. Call this after deploying code that introduced new
   * permission keys (e.g. shipping a new module like Cooperative) so the
   * DB-stored permission catalog catches up and the ADMIN role gets the
   * new perms wired in automatically. Idempotent.
   */
  app.post(
    '/sync',
    { preHandler: app.requirePermission('admin.roles') },
    async (req) => {
      const permResult = await permissions.seed();
      const roleResult = await roles.seedDefaults();
      await audit.record({
        action: 'RBAC_SYNC',
        actorId: req.user.sub,
        targetType: 'System',
        targetId: 'rbac',
        payload: { permissions: permResult, roles: roleResult },
      });
      return { permissions: permResult, roles: roleResult };
    },
  );

  // ─── Permissions ────────────────────────────────────────────────────

  app.get(
    '/permissions',
    { preHandler: app.requirePermission('admin.roles', 'admin.users') },
    async () => permissions.list(),
  );

  // ─── Roles ─────────────────────────────────────────────────────────

  app.get(
    '/roles',
    { preHandler: app.requirePermission('admin.roles', 'admin.users') },
    async () => roles.list(),
  );

  app.get<{ Params: { key: string } }>(
    '/roles/:key',
    { preHandler: app.requirePermission('admin.roles', 'admin.users') },
    async (req, reply) => {
      const r = await roles.findByKeyWithPermissions(req.params.key);
      if (!r) return reply.code(404).send({ error: 'NotFound' });
      return r;
    },
  );

  app.post(
    '/roles',
    { preHandler: app.requirePermission('admin.roles') },
    async (req, reply) => {
      const parsed = createRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      try {
        const role = await roles.create(parsed.data);
        await audit.record({
          action: 'ROLE_CREATE',
          actorId: req.user.sub,
          targetType: 'Role',
          targetId: role.id,
          payload: { key: role.key, permissions: parsed.data.permissions },
        });
        return reply.code(201).send(role);
      } catch (err) {
        return reply.code(409).send({ error: 'Conflict', message: (err as Error).message });
      }
    },
  );

  app.patch<{ Params: { key: string } }>(
    '/roles/:key',
    { preHandler: app.requirePermission('admin.roles') },
    async (req, reply) => {
      const parsed = updateRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      const role = await roles.update(req.params.key, parsed.data);
      await audit.record({
        action: 'ROLE_UPDATE',
        actorId: req.user.sub,
        targetType: 'Role',
        targetId: role.id,
        payload: { key: role.key, ...parsed.data },
      });
      return role;
    },
  );

  app.delete<{ Params: { key: string } }>(
    '/roles/:key',
    { preHandler: app.requirePermission('admin.roles') },
    async (req, reply) => {
      try {
        const r = await roles.delete(req.params.key);
        await audit.record({
          action: 'ROLE_DELETE',
          actorId: req.user.sub,
          targetType: 'Role',
          targetId: r.id,
          payload: { key: r.key },
        });
        return r;
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  // ─── User role assignments ─────────────────────────────────────────

  app.get(
    '/users',
    { preHandler: app.requirePermission('admin.users') },
    async () => {
      const users = await app.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          active: true,
          createdAt: true,
          roleAssignments: {
            include: { role: { select: { key: true, name: true, system: true } } },
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
    },
  );

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/roles',
    { preHandler: app.requirePermission('admin.users') },
    async (req) => roles.listAssignmentsForUser(req.params.userId),
  );

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/roles',
    { preHandler: app.requirePermission('admin.users') },
    async (req, reply) => {
      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      try {
        const a = await roles.assign(req.params.userId, parsed.data.roleKey, req.user.sub);
        await audit.record({
          action: 'USER_ROLE_ASSIGN',
          actorId: req.user.sub,
          targetType: 'User',
          targetId: req.params.userId,
          payload: { roleKey: parsed.data.roleKey },
        });
        return reply.code(201).send(a);
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  app.delete<{ Params: { userId: string; roleKey: string } }>(
    '/users/:userId/roles/:roleKey',
    { preHandler: app.requirePermission('admin.users') },
    async (req, reply) => {
      // Self-lockout guard: nobody can strip their own ADMIN role —
      // they'd lose admin.users on the very next request and get stuck.
      // Removing admin from another admin is fine; that's the way to
      // demote a teammate.
      if (
        req.params.userId === req.user.sub &&
        req.params.roleKey === 'ADMIN'
      ) {
        return reply.code(400).send({
          error: 'BadRequest',
          message:
            'You cannot remove the ADMIN role from yourself. Ask another admin to do it.',
        });
      }
      await roles.unassign(req.params.userId, req.params.roleKey);
      await audit.record({
        action: 'USER_ROLE_UNASSIGN',
        actorId: req.user.sub,
        targetType: 'User',
        targetId: req.params.userId,
        payload: { roleKey: req.params.roleKey },
      });
      return { ok: true };
    },
  );
}
