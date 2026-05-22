/**
 * RBAC admin: permission catalog, role CRUD, user CRUD, role
 * assignments. Most routes guarded by `admin.roles`, with user-facing
 * actions guarded by `admin.users`.
 *
 * The four canonical roles can be edited but not deleted; their
 * `system` flag is enforced at the repository layer (the service
 * surfaces the resulting failure as a 400).
 *
 * Layered: routes → controller → service → repos + audit.
 */

import {
  AuditLogRepository,
  PermissionRepository,
  RoleRepository,
} from "@loan/db";
import type { FastifyInstance } from "fastify";

import { RbacController } from "./rbac.controller.js";
import { RbacService } from "./rbac.service.js";
import { UsersBulkImportService } from "./users-bulk-import.service.js";

export async function rbacRoutes(app: FastifyInstance) {
  const roles = new RoleRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);
  const service = new RbacService(
    app.prisma,
    new PermissionRepository(app.prisma),
    roles,
    audit,
    app.notifications,
    app.log,
  );
  const bulkImport = new UsersBulkImportService(app.prisma, roles, audit);
  const ctrl = new RbacController(service, bulkImport);

  app.addHook("preHandler", app.authenticate);

  // ─── catalog sync ─────────────────────────────────────────────────

  app.post(
    "/sync",
    { preHandler: app.requirePermission("admin.roles") },
    ctrl.sync,
  );

  // ─── permissions ──────────────────────────────────────────────────

  app.get(
    "/permissions",
    { preHandler: app.requirePermission("admin.roles", "admin.users") },
    ctrl.listPermissions,
  );

  // Reverse lookup: "who currently holds permission X?". Permission-
  // gated on either admin.roles or admin.audit_log so security auditors
  // can answer attribution questions without admin.users.
  app.get<{ Params: { key: string } }>(
    "/permissions/:key/holders",
    {
      preHandler: app.requirePermission("admin.roles", "admin.audit_log"),
    },
    ctrl.listPermissionHolders,
  );

  // ─── roles ────────────────────────────────────────────────────────

  app.get(
    "/roles",
    { preHandler: app.requirePermission("admin.roles", "admin.users") },
    ctrl.listRoles,
  );

  app.get<{ Params: { key: string } }>(
    "/roles/:key",
    { preHandler: app.requirePermission("admin.roles", "admin.users") },
    ctrl.findRole,
  );

  app.post(
    "/roles",
    { preHandler: app.requirePermission("admin.roles") },
    ctrl.createRole,
  );

  app.patch<{ Params: { key: string } }>(
    "/roles/:key",
    { preHandler: app.requirePermission("admin.roles") },
    ctrl.updateRole,
  );

  // Pre-flight check before submitting a role update: returns the
  // user-loss count per removed permission so the UI can show a
  // confirmation dialog. Read-only — never writes anything.
  app.post<{ Params: { key: string } }>(
    "/roles/:key/edit-impact",
    { preHandler: app.requirePermission("admin.roles") },
    ctrl.computeRoleEditImpact,
  );

  app.delete<{ Params: { key: string } }>(
    "/roles/:key",
    { preHandler: app.requirePermission("admin.roles") },
    ctrl.deleteRole,
  );

  // ─── users ────────────────────────────────────────────────────────

  app.get(
    "/users",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.listUsers,
  );

  app.post(
    "/users",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.createUser,
  );

  // Bulk onboarding (CSV → many users). 207 Multi-Status partial
  // success is the default expectation.
  app.post(
    "/users/bulk-import",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.bulkImportUsers,
  );

  // ─── user role assignments ────────────────────────────────────────

  app.get<{ Params: { userId: string } }>(
    "/users/:userId/roles",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.listUserRoles,
  );

  app.post<{ Params: { userId: string } }>(
    "/users/:userId/roles",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.assignRole,
  );

  app.delete<{ Params: { userId: string; roleKey: string } }>(
    "/users/:userId/roles/:roleKey",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.unassignRole,
  );
}
