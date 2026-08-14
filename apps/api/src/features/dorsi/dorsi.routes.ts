import type { FastifyInstance } from "fastify";

import { routeSchema } from "../../lib/openapi";

import type { DorsiController } from "./dorsi.controller";
import {
  boardApprovalSchema,
  checkSchema,
  configUpdateSchema,
  deactivateSchema,
  dorsiBoardApprovalResponseSchema,
  dorsiCheckResponseSchema,
  dorsiConfigResponseSchema,
  dorsiConfigUpdateResponseSchema,
  dorsiCustomerParamSchema,
  dorsiIdParamSchema,
  dorsiListResponseSchema,
  dorsiRecordResponseSchema,
  dorsiScreenResponseSchema,
  dorsiUtilizationResponseSchema,
  screenByNameSchema,
  tagSchema,
} from "./schemas";

const TAGS = ["dorsi"];

/**
 * HTTP wiring for the DORSI compliance feature. Permissions are
 * declared per-route as `preHandler: app.requirePermission(...)` so
 * the read / write / board-approve / system-config splits are visible
 * at a glance.
 *
 * 402 on every route: the whole /dorsi prefix sits behind the
 * `compliance.dorsi` licence gate (see index.ts).
 */
export function registerDorsiHttp(
  app: FastifyInstance,
  controller: DorsiController,
): void {
  // Register
  app.get(
    "/",
    {
      preHandler: app.requirePermission("dorsi.read"),
      schema: routeSchema({
        summary:
          "The active DORSI register, newest tag first, borrower " +
          "identity joined in.",
        tags: TAGS,
        permission: "dorsi.read",
        response: dorsiListResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    controller.list,
  );
  app.post(
    "/",
    {
      preHandler: app.requirePermission("dorsi.tag"),
      schema: routeSchema({
        summary:
          "Tag a customer as Director / Officer / Stockholder / " +
          "Related-Interest. Re-tagging reactivates the existing row.",
        tags: TAGS,
        permission: "dorsi.tag",
        body: tagSchema,
        response: dorsiRecordResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.tag,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/deactivate",
    {
      preHandler: app.requirePermission("dorsi.tag"),
      schema: routeSchema({
        summary:
          "Deactivate a register row, keeping it (and the reason) on " +
          "file. 400 covers an unknown id — the miss is not mapped to 404.",
        tags: TAGS,
        permission: "dorsi.tag",
        params: dorsiIdParamSchema,
        body: deactivateSchema,
        response: dorsiRecordResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.deactivate,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/review",
    {
      preHandler: app.requirePermission("dorsi.tag"),
      schema: routeSchema({
        summary:
          "Stamp a periodic review on a register row. 400 covers an " +
          "unknown id — the miss is not mapped to 404.",
        tags: TAGS,
        permission: "dorsi.tag",
        params: dorsiIdParamSchema,
        response: dorsiRecordResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.review,
  );

  // Per-customer lookup + utilization snapshot
  app.get<{ Params: { customerId: string } }>(
    "/customer/:customerId",
    {
      preHandler: app.requirePermission("dorsi.read"),
      schema: routeSchema({
        summary:
          "The DORSI record for one customer, active or not. 404 = never " +
          "tagged.",
        tags: TAGS,
        permission: "dorsi.read",
        params: dorsiCustomerParamSchema,
        response: dorsiRecordResponseSchema,
        errors: [401, 402, 403, 404],
      }),
    },
    controller.showForCustomer,
  );
  app.get(
    "/utilization",
    {
      preHandler: app.requirePermission("dorsi.read"),
      schema: routeSchema({
        summary:
          "Current DORSI cap utilization — aggregate and per borrower. " +
          "All figures computed in JS: numbers.",
        tags: TAGS,
        permission: "dorsi.read",
        response: dorsiUtilizationResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    controller.utilization,
  );

  // Loan check + auto screen
  app.post(
    "/check",
    {
      preHandler: app.requirePermission("dorsi.read"),
      schema: routeSchema({
        summary:
          "Preview a proposed loan against the DORSI caps without " +
          "persisting anything. Unconfigured equity fails closed to " +
          "BOARD_REQUIRED.",
        tags: TAGS,
        permission: "dorsi.read",
        body: checkSchema,
        response: dorsiCheckResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.checkLoan,
  );
  app.post(
    "/screen-by-name",
    {
      preHandler: app.requirePermission("dorsi.read"),
      schema: routeSchema({
        summary:
          "Fuzzy-screen a name against the active register (run at " +
          "customer onboarding). Empty array = no potential match.",
        tags: TAGS,
        permission: "dorsi.read",
        body: screenByNameSchema,
        response: dorsiScreenResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.screenByName,
  );

  // Board approval
  app.post(
    "/board-approval",
    {
      preHandler: app.requirePermission("dorsi.board_approve"),
      schema: routeSchema({
        summary:
          "Record the board's approval of a cap-breaching loan, " +
          "snapshotting the projected utilization it attested to. " +
          "Upserts per loan. 400 covers an unknown loan id.",
        tags: TAGS,
        permission: "dorsi.board_approve",
        body: boardApprovalSchema,
        response: dorsiBoardApprovalResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.recordBoardApproval,
  );
  /*
   * No schema on this one: it answers the approval row OR a literal
   * `null` body when none exists, and routeSchema has no way to say
   * "object or null" at the top level (the permissive pass cannot enter
   * an anyOf). Documenting only the object shape would make the null
   * answer a serialiser surprise.
   */
  app.get<{ Params: { loanId: string } }>(
    "/board-approval/:loanId",
    { preHandler: app.requirePermission("dorsi.read") },
    controller.findBoardApprovalForLoan,
  );

  // Config
  app.get(
    "/config",
    {
      preHandler: app.requirePermission("dorsi.read"),
      schema: routeSchema({
        summary: "The cap base (company total equity) and who last set it.",
        tags: TAGS,
        permission: "dorsi.read",
        response: dorsiConfigResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    controller.getConfig,
  );
  app.put(
    "/config",
    {
      preHandler: app.requirePermission("admin.system_config"),
      schema: routeSchema({
        summary:
          "Set the company total equity the DORSI caps are computed " +
          "from. Echoes only the value written.",
        tags: TAGS,
        permission: "admin.system_config",
        body: configUpdateSchema,
        response: dorsiConfigUpdateResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.updateConfig,
  );
}
