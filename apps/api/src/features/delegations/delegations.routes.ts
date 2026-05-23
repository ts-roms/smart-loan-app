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
 * Layered: routes → controller → service → repo + audit.
 */

import { AuditLogRepository, DelegationRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { DelegationController } from "./delegations.controller";
import { DelegationService } from "./delegations.service";

declare module "fastify" {
  interface FastifyRequest {
    delegationServices?: {
      delegations: DelegationService;
      resolveCallerPerms: (userId: string) => Promise<Set<string>>;
    };
  }
}

export async function delegationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.delegationServices = {
      delegations: new DelegationService(
        prisma,
        new DelegationRepository(prisma),
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
        (userId) => app.resolvePermissions(userId),
        app.notifications(prisma),
        app.log,
      ),
      resolveCallerPerms: (userId: string) => app.resolvePermissions(userId),
    };
  });

  const ctrl = new DelegationController();

  app.get("/users/directory", ctrl.userDirectory);
  app.get("/", ctrl.listMine);
  app.get(
    "/all",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.listAll,
  );
  app.get("/active", ctrl.listActive);

  // Resolved-permissions preview — the service enforces that the
  // caller is either the delegator, the delegate, or holds
  // admin.users; no preHandler permission gate (this needs to be
  // reachable by the delegate themselves, who may have no admin
  // perms at all).
  app.get<{ Params: { id: string } }>("/:id/preview", ctrl.preview);

  app.post("/", ctrl.create);
  app.post<{ Params: { id: string } }>("/:id/revoke", ctrl.revoke);
  app.post<{ Params: { id: string } }>("/:id/extend", ctrl.extend);
}
