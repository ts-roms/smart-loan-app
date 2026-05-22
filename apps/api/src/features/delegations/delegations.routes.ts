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

import { DelegationController } from "./delegations.controller.js";
import { DelegationService } from "./delegations.service.js";

export async function delegationRoutes(app: FastifyInstance) {
  const service = new DelegationService(
    app.prisma,
    new DelegationRepository(app.prisma),
    new AuditLogRepository(app.prisma),
    (userId) => app.resolvePermissions(userId),
  );

  // Caller permissions live on the request after the auth hooks run.
  // The controller stays Fastify-aware only at the request edge — the
  // service never sees a FastifyRequest.
  const resolveCallerPerms = async (req: FastifyRequest) =>
    req.permissions ?? (await app.resolvePermissions(req.user.sub));

  const ctrl = new DelegationController(service, resolveCallerPerms);

  app.addHook("preHandler", app.authenticate);

  app.get("/users/directory", ctrl.userDirectory);
  app.get("/", ctrl.listMine);
  app.get(
    "/all",
    { preHandler: app.requirePermission("admin.users") },
    ctrl.listAll,
  );
  app.get("/active", ctrl.listActive);

  app.post("/", ctrl.create);
  app.post<{ Params: { id: string } }>("/:id/revoke", ctrl.revoke);
  app.post<{ Params: { id: string } }>("/:id/extend", ctrl.extend);
}
