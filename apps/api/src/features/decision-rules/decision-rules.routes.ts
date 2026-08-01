/**
 * Decision-rule admin: rules driving /loans/:id/decide.
 *
 *   GET    /decision-rules            loans.read
 *   POST   /decision-rules            admin.decision_rules
 *   PATCH  /decision-rules/:id        admin.decision_rules
 *   DELETE /decision-rules/:id        admin.decision_rules
 *   POST   /decision-rules/seed       admin.decision_rules
 *
 * Phase 2: per-request service wiring via req.decisionRulesServices.
 */

import { DecisionRuleRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { DecisionRuleController } from "./decision-rules.controller";
import { DecisionRuleService } from "./decision-rules.service";

declare module "fastify" {
  interface FastifyRequest {
    decisionRulesServices?: { rules: DecisionRuleService };
  }
}

export async function decisionRuleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
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
  app.get("/", { preHandler: app.requirePermission("loans.read") }, ctrl.list);
  app.post(
    "/",
    { preHandler: app.requirePermission("admin.decision_rules") },
    ctrl.create,
  );
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("admin.decision_rules") },
    ctrl.update,
  );
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("admin.decision_rules") },
    ctrl.delete,
  );
  app.post(
    "/seed",
    { preHandler: app.requirePermission("admin.decision_rules") },
    ctrl.seedDefaults,
  );
}
