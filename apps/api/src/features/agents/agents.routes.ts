/**
 * Field agents — the directory, and the book each agent has written.
 *
 *   GET    /agents            agents.read     directory + rolled-up totals
 *   POST   /agents            agents.manage   register a user as an agent
 *   GET    /agents/me         agents.self     the signed-in agent's own book
 *   GET    /agents/:id        agents.read
 *   PATCH  /agents/:id        agents.manage   rate, territory, active
 *   GET    /agents/:id/book   agents.read     one agent's assisted loans
 *
 *   GET    /agents/payouts        agents.read     payout history
 *   POST   /agents/payouts        agents.payout   pay an agent
 *   POST   /agents/payouts/:id/void  agents.payout
 *   GET    /agents/me/payable     agents.self     what I am owed
 *   GET    /agents/:id/payable    agents.read     what an agent is owed
 *
 * `/agents/me` is declared BEFORE `/agents/:id` on purpose. Fastify's
 * router prefers static segments over parameterised ones so the order
 * does not actually decide it — but a reader scanning the file should
 * not have to know that to be sure "me" isn't being swallowed as an id.
 *
 * The split between `agents.read` and `agents.self` is the point of the
 * module. An agent is paid per loan they land, which is exactly what
 * makes a broad grant dangerous: `agents.read` would let them page
 * through every other agent's book, and `loans.read` would hand them the
 * whole borrower list. `/agents/me` resolves the agent from the token
 * subject, so there is no id an agent can pass to read anyone else's.
 *
 * Phase 2: per-request repository wiring via req.agentServices.
 */

import { AgentRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { AgentsController } from "./agents.controller";

declare module "fastify" {
  interface FastifyRequest {
    agentServices?: { agents: AgentRepository };
  }
}

export async function agentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.agentServices = { agents: new AgentRepository(req.tenantCtx.prisma) };
  });

  const ctrl = new AgentsController();

  app.get("/", { preHandler: app.requirePermission("agents.read") }, ctrl.list);
  app.post(
    "/",
    { preHandler: app.requirePermission("agents.manage") },
    ctrl.create,
  );
  app.get(
    "/me",
    { preHandler: app.requirePermission("agents.self") },
    ctrl.myBook,
  );
  app.get(
    "/me/payable",
    { preHandler: app.requirePermission("agents.self") },
    ctrl.myPayable,
  );

  /*
   * Payout routes before "/:id" for the same readability reason as
   * "/me" — Fastify prefers static segments, but nobody should have to
   * know that to be sure "payouts" isn't being read as an agent id.
   *
   * `agents.payout` is held apart from `agents.manage`: cash leaving the
   * till is the cashier's desk, and the person who sets what an agent
   * earns should not also be the one handing it over.
   */
  app.get(
    "/payouts",
    { preHandler: app.requirePermission("agents.read") },
    ctrl.listPayouts,
  );
  app.post(
    "/payouts",
    { preHandler: app.requirePermission("agents.payout") },
    ctrl.createPayout,
  );
  app.post<{ Params: { id: string } }>(
    "/payouts/:id/void",
    { preHandler: app.requirePermission("agents.payout") },
    ctrl.voidPayout,
  );
  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("agents.read") },
    ctrl.get,
  );
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("agents.manage") },
    ctrl.update,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/book",
    { preHandler: app.requirePermission("agents.read") },
    ctrl.book,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/payable",
    { preHandler: app.requirePermission("agents.read") },
    ctrl.payable,
  );
}
