import type { FastifyInstance } from "fastify";

import type { DorsiController } from "./dorsi.controller";

/**
 * HTTP wiring for the DORSI compliance feature. Permissions are
 * declared per-route as `preHandler: app.requirePermission(...)` so
 * the read / write / board-approve / system-config splits are visible
 * at a glance.
 */
export function registerDorsiHttp(
  app: FastifyInstance,
  controller: DorsiController,
): void {
  // Register
  app.get(
    "/",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.list,
  );
  app.post(
    "/",
    { preHandler: app.requirePermission("dorsi.tag") },
    controller.tag,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/deactivate",
    { preHandler: app.requirePermission("dorsi.tag") },
    controller.deactivate,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/review",
    { preHandler: app.requirePermission("dorsi.tag") },
    controller.review,
  );

  // Per-customer lookup + utilization snapshot
  app.get<{ Params: { customerId: string } }>(
    "/customer/:customerId",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.showForCustomer,
  );
  app.get(
    "/utilization",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.utilization,
  );

  // Loan check + auto screen
  app.post(
    "/check",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.checkLoan,
  );
  app.post(
    "/screen-by-name",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.screenByName,
  );

  // Board approval
  app.post(
    "/board-approval",
    { preHandler: app.requirePermission("dorsi.board_approve") },
    controller.recordBoardApproval,
  );
  app.get<{ Params: { loanId: string } }>(
    "/board-approval/:loanId",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.findBoardApprovalForLoan,
  );

  // Config
  app.get(
    "/config",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.getConfig,
  );
  app.put(
    "/config",
    { preHandler: app.requirePermission("admin.system_config") },
    controller.updateConfig,
  );
}
