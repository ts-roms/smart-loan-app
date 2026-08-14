/**
 * Delegation routes — admin permission delegation.
 *
 *   GET    /delegations            caller's own delegations (granted + held)
 *   GET    /delegations/all        system-wide list (admin.users)
 *   GET    /delegations/active     active delegations the caller holds
 *   GET    /delegations/users/directory   lightweight user picker
 *   POST   /delegations            create one
 *   POST   /delegations/:id/revoke revoke early
 *   POST   /delegations/:id/extend push the end date out
 *
 * Authorization rules (enforced in the service):
 *   • caller can only act as the delegator for themselves, unless they
 *     hold `admin.users`
 *   • every explicit permission key being delegated must already be one
 *     the delegator currently holds — empty list = "all of mine"
 *
 * Those two rules make the CRUD routes genuinely self-scoped, which is
 * why they carry no `requirePermission` gate: the caller-id always
 * comes from the JWT subject and you can't delegate authority you
 * don't have. `/users/directory` is the exception — see below.
 *
 * Layered: routes → controller → service → repo + audit.
 */

import { AuditLogRepository, DelegationRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { DelegationController } from "./delegations.controller";
import { DelegationService } from "./delegations.service";
import {
  createSchema,
  delegationIdParamSchema,
  delegationListResponseSchema,
  delegationPreviewResponseSchema,
  delegationResponseSchema,
  extendSchema,
  myDelegationsResponseSchema,
  userDirectoryResponseSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    delegationServices?: {
      delegations: DelegationService;
      resolveCallerPerms: (userId: string) => Promise<Set<string>>;
    };
  }
}

export async function delegationRoutes(app: FastifyInstance) {
  // onRequest, not preHandler. The three POSTs below now declare body
  // schemas, and Fastify validates at preValidation — BEFORE preHandler.
  // Left where it was, an unauthenticated POST /delegations with a
  // malformed body was answered 400 naming delegateId / startsAt /
  // endsAt: a description of how to hand someone else's authority
  // around, given to a caller who has not proved they hold any. Same
  // fix, same reason, as loans.routes.ts.
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.delegationServices = {
      delegations: new DelegationService(
        prisma,
        new DelegationRepository(prisma),
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
        (userId) => app.resolvePermissions(userId, prisma),
        app.notifications(prisma),
        app.log,
      ),
      resolveCallerPerms: (userId: string) =>
        app.resolvePermissions(userId, prisma),
    };
  });

  const ctrl = new DelegationController();
  const TAGS = ["delegations"];

  /**
   * Picker for "delegate to whom". Unlike the rest of this feature it
   * is NOT self-scoped — it returns every active user's name, email and
   * role — so it needs a gate. `loans.read` is used as the staff
   * discriminator: all three staff roles (LOAN_OFFICER, ACCOUNTANT,
   * ADMIN) hold it and CUSTOMER does not, and any of them may need to
   * hand their authority to a colleague while on leave. `admin.users`
   * would be wrong here — it would restrict delegation to admins.
   */
  app.get(
    "/users/directory",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "Active staff accounts available to delegate to, by name. " +
          "Borrower accounts are excluded.",
        tags: TAGS,
        permission: "loans.read",
        response: userDirectoryResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.userDirectory,
  );
  app.get(
    "/",
    {
      schema: routeSchema({
        summary:
          "The caller's own delegations, split into ones they granted " +
          "and ones they hold.",
        tags: TAGS,
        response: myDelegationsResponseSchema,
        errors: [401],
      }),
    },
    ctrl.listMine,
  );
  app.get(
    "/all",
    {
      preHandler: app.requirePermission("admin.users"),
      schema: routeSchema({
        summary: "Every delegation in the tenant, newest first. Capped at 200.",
        tags: TAGS,
        permission: "admin.users",
        response: delegationListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listAll,
  );
  app.get(
    "/active",
    {
      schema: routeSchema({
        summary:
          "Delegations the caller holds that are live right now — not " +
          "revoked, and inside their date window.",
        tags: TAGS,
        response: delegationListResponseSchema,
        errors: [401],
      }),
    },
    ctrl.listActive,
  );

  // Resolved-permissions preview — the service enforces that the
  // caller is either the delegator, the delegate, or holds
  // admin.users; no preHandler permission gate (this needs to be
  // reachable by the delegate themselves, who may have no admin
  // perms at all).
  app.get<{ Params: { id: string } }>(
    "/:id/preview",
    {
      schema: routeSchema({
        summary:
          "What this delegation grants right now, including keys it named " +
          "that the delegator no longer holds.",
        tags: TAGS,
        params: delegationIdParamSchema,
        response: delegationPreviewResponseSchema,
        // 403 for anyone who is neither party nor an admin — otherwise
        // this would be a way to read other people's delegation contents.
        errors: [401, 403, 404],
      }),
    },
    ctrl.preview,
  );

  app.post(
    "/",
    {
      schema: routeSchema({
        summary:
          "Grant a delegation. An empty `permissions` list means all of " +
          "the delegator's, resolved when used rather than frozen now.",
        tags: TAGS,
        body: createSchema,
        response: delegationResponseSchema,
        status: 201,
        // 403 is the two authority refusals: naming someone else as the
        // delegator without admin.users, and listing a permission the
        // delegator does not actually hold.
        errors: [400, 401, 403],
      }),
    },
    ctrl.create,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/revoke",
    {
      /*
       * No `body` schema here alone. `revokeSchema` is entirely
       * optional and the controller parses `req.body ?? {}`, so a
       * body-less POST is a supported call; declaring an object body
       * would have Fastify answer it 400 "must be object". Same
       * measurement as /admin/users/:userId/force-logout.
       */
      schema: routeSchema({
        summary:
          "End a delegation before its `endsAt`. Optional body: " +
          "`{ reason }`.",
        tags: TAGS,
        params: delegationIdParamSchema,
        response: delegationResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.revoke,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/extend",
    {
      schema: routeSchema({
        summary:
          "Push a delegation's end date out. Shortening is refused — that " +
          "is a revoke, and has its own audit story.",
        tags: TAGS,
        params: delegationIdParamSchema,
        body: extendSchema,
        response: delegationResponseSchema,
        // 409 is extending one that was already revoked.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.extend,
  );
}
