/**
 * Decision-rule admin: rules driving /loans/:id/decide.
 *
 *   GET    /decision-rules              loans.read
 *   GET    /decision-rules/as-of        loans.read
 *   GET    /decision-rules/:id/versions loans.read
 *   POST   /decision-rules              admin.decision_rules
 *   PATCH  /decision-rules/:id          admin.decision_rules
 *   DELETE /decision-rules/:id          admin.decision_rules  (retires)
 *   POST   /decision-rules/seed         admin.decision_rules
 *
 * Phase 2: per-request service wiring via req.decisionRulesServices.
 */

import { DecisionRuleRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { DecisionRuleController } from "./decision-rules.controller";
import { DecisionRuleService } from "./decision-rules.service";
import {
  asOfQuerySchema,
  createRuleSchema,
  idParamSchema,
  retireRuleSchema,
  ruleListResponseSchema,
  ruleResponseSchema,
  ruleVersionListResponseSchema,
  seedResponseSchema,
  updateRuleSchema,
} from "./schemas";

const TAGS = ["decision-rules"];

declare module "fastify" {
  interface FastifyRequest {
    decisionRulesServices?: { rules: DecisionRuleService };
  }
}

export async function decisionRuleRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler — and this matters now that routes in this
   * group carry request schemas.
   *
   * Fastify's order is onRequest -> preValidation -> preHandler. With
   * `authenticate` at preHandler, an UNAUTHENTICATED request carrying a
   * malformed body got a 400 describing the schema instead of a 401:
   * the API parsed, validated and explained itself to an anonymous
   * caller before ever checking who they were. Verified before the fix
   * (400) and after (401).
   *
   * `jwtVerify` reads the Authorization header only, so it is safe this
   * early. Anything that needs the body — `resolveTenantFromBody` on the
   * login route — stays where it is.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.decisionRulesServices = {
      rules: new DecisionRuleService(
        new DecisionRuleRepository(req.tenantCtx.prisma),
      ),
    };
  });

  const ctrl = new DecisionRuleController();

  // Reading the rules is `loans.read`, not `admin.decision_rules` —
  // officers need to see which rule fired on a decision, but the rules
  // are internal underwriting policy and shouldn't be visible to the
  // borrower they're being applied to.
  app.get(
    "/",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary: "List the live rules, in priority order.",
        tags: TAGS,
        permission: "loans.read",
        response: ruleListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.list,
  );
  /*
   * Registered before "/:id/..." would matter, and kept literal, so
   * "as-of" is never mistaken for a rule id.
   *
   * Both read paths are `loans.read` for the same reason the listing is:
   * an officer explaining a decision needs to see the rule that made it,
   * and the history is that need extended backwards — a decision made
   * last March is explained by last March's rule, not today's.
   */
  app.get<{ Querystring: { at?: string } }>(
    "/as-of",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary: "The whole rule set as it stood at a moment.",
        tags: TAGS,
        permission: "loans.read",
        querystring: asOfQuerySchema,
        response: ruleVersionListResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.asOf,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/versions",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary: "Every revision of one rule, newest first.",
        tags: TAGS,
        permission: "loans.read",
        params: idParamSchema,
        response: ruleVersionListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.history,
  );
  app.post(
    "/",
    {
      preHandler: app.requirePermission("admin.decision_rules"),
      schema: routeSchema({
        summary: "Create a rule and open version 1.",
        tags: TAGS,
        permission: "admin.decision_rules",
        body: createRuleSchema,
        response: ruleResponseSchema,
        status: 201,
        // 409 is the duplicate name, not a malformed body.
        errors: [400, 401, 403, 409],
      }),
    },
    ctrl.create,
  );
  app.patch<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("admin.decision_rules"),
      schema: routeSchema({
        summary:
          "Edit a rule. Mints a version only when something decisive changed.",
        tags: TAGS,
        permission: "admin.decision_rules",
        params: idParamSchema,
        body: updateRuleSchema,
        response: ruleResponseSchema,
        // 409 here means the rule is RETIRED — well-formed, permitted,
        // and refused by the target's state. Retrying will not help.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.update,
  );
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("admin.decision_rules"),
      schema: routeSchema({
        summary:
          "Retire a rule. It stops firing; its history and the decisions " +
          "citing it survive.",
        tags: TAGS,
        permission: "admin.decision_rules",
        params: idParamSchema,
        body: retireRuleSchema,
        response: ruleResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.delete,
  );
  app.post(
    "/seed",
    {
      preHandler: app.requirePermission("admin.decision_rules"),
      schema: routeSchema({
        summary: "Idempotently seed the shipped default rules.",
        tags: TAGS,
        permission: "admin.decision_rules",
        response: seedResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.seedDefaults,
  );
}
