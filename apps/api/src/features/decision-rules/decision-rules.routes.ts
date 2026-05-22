/**
 * Decision-rule admin: rules driving /loans/:id/decide.
 *
 *   GET    /decision-rules            any authenticated
 *   POST   /decision-rules            admin.decision_rules
 *   PATCH  /decision-rules/:id        admin.decision_rules
 *   DELETE /decision-rules/:id        admin.decision_rules
 *   POST   /decision-rules/seed       admin.decision_rules
 *
 * Layered: routes → controller → service → repo. The service maps
 * unique-name collisions to a Conflict result so the controller can
 * surface a clean 409.
 */

import { DecisionRuleRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { DecisionRuleController } from "./decision-rules.controller.js";
import { DecisionRuleService } from "./decision-rules.service.js";

export async function decisionRuleRoutes(app: FastifyInstance) {
  const ctrl = new DecisionRuleController(
    new DecisionRuleService(new DecisionRuleRepository(app.prisma)),
  );
  app.addHook("preHandler", app.authenticate);

  app.get("/", ctrl.list);

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
