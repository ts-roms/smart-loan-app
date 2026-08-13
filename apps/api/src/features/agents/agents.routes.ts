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

import { routeSchema } from "../../lib/openapi";

import { AgentsController } from "./agents.controller";
import {
  agentBookQuerySchema,
  agentBookResponseSchema,
  agentIdParamSchema,
  agentListQuerySchema,
  agentListResponseSchema,
  agentPayableResponseSchema,
  agentRowResponseSchema,
  agentSummaryResponseSchema,
  createAgentSchema,
  createPayoutRequestSchema,
  myPayableResponseSchema,
  payoutCreateResponseSchema,
  payoutListQuerySchema,
  payoutListResponseSchema,
  payoutRowResponseSchema,
  updateAgentSchema,
  voidPayoutSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    agentServices?: { agents: AgentRepository };
  }
}

const TAGS = ["agents"];

export async function agentRoutes(app: FastifyInstance) {
  // onRequest, not preHandler — routes in this group carry request
  // schemas, and Fastify validates at preValidation, BEFORE preHandler.
  // With authenticate at preHandler an unauthenticated caller with a
  // malformed body got a 400 describing the schema instead of a 401.
  // See decision-rules.routes.ts for the full account.
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.agentServices = { agents: new AgentRepository(req.tenantCtx.prisma) };
  });

  const ctrl = new AgentsController();

  app.get(
    "/",
    {
      preHandler: app.requirePermission("agents.read"),
      schema: routeSchema({
        summary:
          "The agent directory, each row carrying its rolled-up book " +
          "totals. Filter by ?active and free-text ?q.",
        tags: TAGS,
        querystring: agentListQuerySchema,
        response: agentListResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.list,
  );
  app.post(
    "/",
    {
      preHandler: app.requirePermission("agents.manage"),
      schema: routeSchema({
        summary:
          "Register a user as a field agent. 409 = already one. The " +
          "response is the raw row — commissionRate comes back as a " +
          "Decimal STRING, and no name/email/totals are joined.",
        tags: TAGS,
        body: createAgentSchema,
        response: agentRowResponseSchema,
        status: 201,
        errors: [400, 401, 403, 409],
      }),
    },
    ctrl.create,
  );
  app.get(
    "/me",
    {
      preHandler: app.requirePermission("agents.self"),
      schema: routeSchema({
        summary:
          "The signed-in agent's OWN book — resolved from the token, " +
          "never from an id. 403 = no agent profile on this login.",
        tags: TAGS,
        querystring: agentBookQuerySchema,
        response: agentBookResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.myBook,
  );
  app.get(
    "/me/payable",
    {
      preHandler: app.requirePermission("agents.self"),
      schema: routeSchema({
        summary:
          "What the signed-in agent is owed right now, plus their payout " +
          "history. 403 = no agent profile on this login.",
        tags: TAGS,
        response: myPayableResponseSchema,
        errors: [401, 403],
      }),
    },
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
    {
      preHandler: app.requirePermission("agents.read"),
      schema: routeSchema({
        summary:
          "Payout history (latest 50 by default), voided runs included " +
          "and marked. Filter by ?agentId.",
        tags: TAGS,
        querystring: payoutListQuerySchema,
        response: payoutListResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.listPayouts,
  );
  app.post(
    "/payouts",
    {
      preHandler: app.requirePermission("agents.payout"),
      schema: routeSchema({
        summary:
          "Pay an agent for a chosen set of loans; the amount must equal " +
          "their commissions or the run is refused (409). 409 also covers " +
          "a loan settled by another run meanwhile. `amount` is a number " +
          "in; a Decimal STRING comes back.",
        tags: TAGS,
        body: createPayoutRequestSchema,
        response: payoutCreateResponseSchema,
        status: 201,
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.createPayout,
  );
  app.post<{ Params: { id: string } }>(
    "/payouts/:id/void",
    {
      preHandler: app.requirePermission("agents.payout"),
      schema: routeSchema({
        summary:
          "Void a payout: reverse the ledger entry and free its loans " +
          "to be paid again. The row stays, marked voided. 409 = " +
          "already voided.",
        tags: TAGS,
        params: agentIdParamSchema,
        body: voidPayoutSchema,
        response: payoutRowResponseSchema,
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.voidPayout,
  );
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("agents.read"),
      schema: routeSchema({
        summary: "One agent by id or AGT-number, book totals rolled up.",
        tags: TAGS,
        params: agentIdParamSchema,
        response: agentSummaryResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.get,
  );
  app.patch<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("agents.manage"),
      schema: routeSchema({
        summary:
          "Adjust rate, territory, notes or active. The response is the " +
          "raw row — commissionRate comes back as a Decimal STRING.",
        tags: TAGS,
        params: agentIdParamSchema,
        body: updateAgentSchema,
        response: agentRowResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.update,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/book",
    {
      preHandler: app.requirePermission("agents.read"),
      schema: routeSchema({
        summary:
          "One agent's assisted loans (staff view), with totals over the " +
          "whole book regardless of paging or ?status filter.",
        tags: TAGS,
        params: agentIdParamSchema,
        querystring: agentBookQuerySchema,
        response: agentBookResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.book,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/payable",
    {
      preHandler: app.requirePermission("agents.read"),
      schema: routeSchema({
        summary:
          "What an agent is owed right now — booked commissions no " +
          "payout has settled — and the loans behind the figure.",
        tags: TAGS,
        params: agentIdParamSchema,
        response: agentPayableResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    ctrl.payable,
  );
}
