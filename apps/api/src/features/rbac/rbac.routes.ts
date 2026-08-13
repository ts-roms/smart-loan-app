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
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { RbacController } from "./rbac.controller";
import { RbacService } from "./rbac.service";
import { UsersBulkImportService } from "./users-bulk-import.service";
import {
  assignSchema,
  createRoleSchema,
  createUserSchema,
  editImpactSchema,
  forceLogoutResponseSchema,
  okResponseSchema,
  permissionHoldersResponseSchema,
  permissionKeyParamSchema,
  permissionListResponseSchema,
  permissionPatchSchema,
  permissionResponseSchema,
  roleAssignmentResponseSchema,
  roleDetailResponseSchema,
  roleEditImpactResponseSchema,
  roleKeyParamSchema,
  roleListResponseSchema,
  roleResponseSchema,
  setUserActiveResponseSchema,
  setUserActiveSchema,
  syncResponseSchema,
  updateRoleSchema,
  userBulkImportResponseSchema,
  userBulkImportSchema,
  userCreatedResponseSchema,
  userIdParamSchema,
  userListResponseSchema,
  userRoleListResponseSchema,
  userRoleParamSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    rbacServices?: {
      rbac: RbacService;
      bulkImport: UsersBulkImportService;
    };
  }
}

export async function rbacRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler — and moving it is the whole reason this
   * group could take request schemas at all.
   *
   * Fastify validates a declared body/params/querystring at
   * preValidation, which runs BEFORE preHandler. With `authenticate`
   * one stage later, an unauthenticated caller posting a malformed body
   * to POST /admin/users was answered 400 with a description of the
   * schema — the account-creation shape handed to someone who had not
   * proved who they were, and the permission gate never consulted.
   * onRequest runs before validation, so the 401 comes back first.
   *
   * Same fix, same reason, as loans.routes.ts and decision-rules.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    const roles = new RoleRepository(prisma);
    const audit = new AuditLogRepository(prisma, req.user?.impersonatedBy);
    req.rbacServices = {
      rbac: new RbacService(
        prisma,
        new PermissionRepository(prisma),
        roles,
        audit,
        app.notifications(prisma),
        app.log,
      ),
      bulkImport: new UsersBulkImportService(prisma, roles, audit),
    };
  });

  const ctrl = new RbacController();
  const TAGS = ["rbac"];

  // ─── catalog sync ─────────────────────────────────────────────────

  app.post(
    "/sync",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Re-seed the in-code permission catalog and canonical role sets. " +
          "Idempotent — safe after every deploy.",
        tags: TAGS,
        response: syncResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.sync,
  );

  // ─── permissions ──────────────────────────────────────────────────

  app.get(
    "/permissions",
    {
      preHandler: app.requirePermission("admin.roles", "admin.users"),
      schema: routeSchema({
        summary: "The whole permission catalog, by category then key.",
        tags: TAGS,
        response: permissionListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listPermissions,
  );

  // Permission staging — flip a perm's lifecycle status. Gated on
  // admin.roles since the change affects which keys the resolver
  // hands out to role members.
  app.patch<{ Params: { key: string } }>(
    "/permissions/:key",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Move a permission through its lifecycle. DRAFT withholds it " +
          "from the resolver; DEPRECATED still grants.",
        tags: TAGS,
        params: permissionKeyParamSchema,
        body: permissionPatchSchema,
        response: permissionResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.patchPermission,
  );

  // Reverse lookup: "who currently holds permission X?". Permission-
  // gated on either admin.roles or admin.audit_log so security auditors
  // can answer attribution questions without admin.users.
  app.get<{ Params: { key: string } }>(
    "/permissions/:key/holders",
    {
      preHandler: app.requirePermission("admin.roles", "admin.audit_log"),
      schema: routeSchema({
        summary:
          "Who holds this permission right now — by role membership and " +
          "by active delegation, counted separately.",
        tags: TAGS,
        params: permissionKeyParamSchema,
        response: permissionHoldersResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.listPermissionHolders,
  );

  // ─── roles ────────────────────────────────────────────────────────

  app.get(
    "/roles",
    {
      preHandler: app.requirePermission("admin.roles", "admin.users"),
      schema: routeSchema({
        summary:
          "Every role with its permission set, inheritance parents and " +
          "member count.",
        tags: TAGS,
        response: roleListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listRoles,
  );

  app.get<{ Params: { key: string } }>(
    "/roles/:key",
    {
      preHandler: app.requirePermission("admin.roles", "admin.users"),
      schema: routeSchema({
        summary: "One role with its permissions and inheritance parents.",
        tags: TAGS,
        params: roleKeyParamSchema,
        response: roleDetailResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.findRole,
  );

  app.post(
    "/roles",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Create a custom role. Answers the bare role row — re-read it " +
          "to see the permission set that was applied.",
        tags: TAGS,
        body: createRoleSchema,
        response: roleResponseSchema,
        status: 201,
        // 400 also covers an inheritance cycle (`error: "InheritanceCycle"`),
        // which is a refusal of the graph rather than of the syntax.
        // 409 is the key already being taken.
        errors: [400, 401, 403, 409],
      }),
    },
    ctrl.createRole,
  );

  app.patch<{ Params: { key: string } }>(
    "/roles/:key",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Update a role's name, description, permission set or parents. " +
          "Answers the bare role row.",
        tags: TAGS,
        params: roleKeyParamSchema,
        body: updateRoleSchema,
        response: roleResponseSchema,
        // An unknown key surfaces as 400 from the repository, not 404 —
        // see the report; it is documented as it behaves.
        errors: [400, 401, 403, 409],
      }),
    },
    ctrl.updateRole,
  );

  // Pre-flight check before submitting a role update: returns the
  // user-loss count per removed permission so the UI can show a
  // confirmation dialog. Read-only — never writes anything.
  app.post<{ Params: { key: string } }>(
    "/roles/:key/edit-impact",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Preview who loses what if this permission set is saved. " +
          "Read-only — writes nothing.",
        tags: TAGS,
        params: roleKeyParamSchema,
        body: editImpactSchema,
        response: roleEditImpactResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.computeRoleEditImpact,
  );

  app.delete<{ Params: { key: string } }>(
    "/roles/:key",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Delete a custom role. System roles are refused — they are " +
          "referenced from code.",
        tags: TAGS,
        params: roleKeyParamSchema,
        response: roleResponseSchema,
        // Both "no such role" and "that one is a system role" come back
        // as 400 from the repository. Documented as sent.
        errors: [400, 401, 403],
      }),
    },
    ctrl.deleteRole,
  );

  // ─── users ────────────────────────────────────────────────────────

  app.get(
    "/users",
    {
      preHandler: app.requirePermission("admin.users"),
      schema: routeSchema({
        summary:
          "Staff and borrower logins, newest first, with server-resolved " +
          "presence and role grants. Capped at 500.",
        tags: TAGS,
        response: userListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listUsers,
  );

  app.post(
    "/users",
    {
      preHandler: app.requirePermission("admin.users"),
      schema: routeSchema({
        summary:
          "Create a login with any primary role, including ADMIN. The " +
          "public /auth/register can only make borrowers.",
        tags: TAGS,
        body: createUserSchema,
        response: userCreatedResponseSchema,
        status: 201,
        // 404 is a named customerId that does not exist; 409 is the
        // email being taken, or that Customer already having a login.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.createUser,
  );

  // Bulk onboarding (CSV → many users). 207 Multi-Status partial
  // success is the default expectation. Feature-gated since this is
  // an ENTERPRISE-tier capability (mass provisioning of staff).
  app.post(
    "/users/bulk-import",
    {
      preHandler: [
        app.requireFeature("bulk.users"),
        app.requirePermission("admin.users"),
      ],
      schema: routeSchema({
        summary:
          "Onboard up to 500 logins in one call. Partial success is the " +
          "normal outcome, hence 207.",
        tags: TAGS,
        body: userBulkImportSchema,
        response: userBulkImportResponseSchema,
        status: 207,
        // 402 is the licence gate: bulk user provisioning is ENTERPRISE.
        errors: [400, 401, 402, 403],
      }),
    },
    ctrl.bulkImportUsers,
  );

  // Enable / disable a login. admin.users, same as creating one —
  // whoever can mint an account can retire it.
  app.patch<{ Params: { userId: string } }>(
    "/users/:userId/active",
    {
      preHandler: app.requirePermission("admin.users"),
      schema: routeSchema({
        summary:
          "Enable or disable a login. Disabling also cuts the sessions " +
          "already in flight, not just the next sign-in.",
        tags: TAGS,
        params: userIdParamSchema,
        body: setUserActiveSchema,
        response: setUserActiveResponseSchema,
        // 409 covers the two state refusals: targeting yourself, and
        // disabling the last active admin on the org.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.setUserActive,
  );

  // ─── user role assignments ────────────────────────────────────────

  app.get<{ Params: { userId: string } }>(
    "/users/:userId/roles",
    {
      preHandler: app.requirePermission("admin.users"),
      schema: routeSchema({
        summary:
          "A user's role grants, oldest first. Expired grants are still " +
          "listed; the resolver ignores them.",
        tags: TAGS,
        params: userIdParamSchema,
        response: userRoleListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listUserRoles,
  );

  app.post<{ Params: { userId: string } }>(
    "/users/:userId/roles",
    {
      preHandler: app.requirePermission("admin.users"),
      schema: routeSchema({
        summary:
          "Grant a role, optionally with an expiry. Re-granting only " +
          "moves the expiry — the original grant's trail is kept.",
        tags: TAGS,
        params: userIdParamSchema,
        body: assignSchema,
        response: roleAssignmentResponseSchema,
        status: 201,
        // A past `expiresAt` is refused at 400: the API never records a
        // grant that was born expired.
        errors: [400, 401, 403],
      }),
    },
    ctrl.assignRole,
  );

  app.delete<{ Params: { userId: string; roleKey: string } }>(
    "/users/:userId/roles/:roleKey",
    {
      preHandler: app.requirePermission("admin.users"),
      schema: routeSchema({
        summary:
          "Revoke a role grant. Removing your own ADMIN, or the org's " +
          "last one, is refused.",
        tags: TAGS,
        params: userRoleParamSchema,
        response: okResponseSchema,
        // Self-lockout is 400; last-admin is 409 — the request is fine,
        // the org's state is what refuses it.
        errors: [400, 401, 403, 409],
      }),
    },
    ctrl.unassignRole,
  );

  // ─── sessions ─────────────────────────────────────────────────────

  // Gated on admin.force_logout ALONE — deliberately not on
  // admin.users. Ending a session is the thing you want a duty officer
  // to be able to do at 2am without also being able to change roles or
  // set passwords, and the two shouldn't travel together.
  app.post<{ Params: { userId: string } }>(
    "/users/:userId/force-logout",
    {
      preHandler: app.requirePermission("admin.force_logout"),
      /*
       * No `body` schema, unlike every other write here, and the reason
       * is measured rather than principled: every field of
       * `forceLogoutSchema` is optional, and the handler reads
       * `req.body ?? {}` precisely so a body-less POST works. Declaring
       * an object body makes Fastify answer that same call 400 "must be
       * object" — at 2am, from a duty officer's curl. Documenting the
       * optional `reason` is not worth breaking the call it belongs to.
       */
      schema: routeSchema({
        summary:
          "End every session a user holds. Does not disable the account — " +
          "they can sign back in immediately. Optional body: `{ reason }`.",
        tags: TAGS,
        params: userIdParamSchema,
        response: forceLogoutResponseSchema,
        // 409 is targeting yourself: well-formed, and would have worked
        // against any other row.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.forceLogout,
  );
}
