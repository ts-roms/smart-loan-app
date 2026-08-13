import type { FastifyInstance } from "fastify";

import { routeSchema } from "../../lib/openapi";
import type { CustomerController } from "./customers.controller";
import {
  archiveCustomerResponseSchema,
  archiveCustomerSchema,
  customerBaseSchema,
  customerExposureResponseSchema,
  customerIdParamSchema,
  customerListQuerySchema,
  customerListResponseSchema,
  customerResponseSchema,
  customerSchema,
  customerSummaryResponseSchema,
  repeatEligibilityResponseSchema,
} from "./schemas";

const TAGS = ["customers"];

/**
 * HTTP wiring for the base customer CRUD surface. This file is
 * intentionally trivial — each endpoint just maps method+path onto a
 * controller method. The interesting code lives in the controller +
 * service.
 *
 * URL convention: `:id` accepts either the UUID or the human
 * "CUST-2026-..." reference number. The frontend navigates via the
 * number; UUIDs still resolve for back-compat with old links.
 *
 * Authorization: every route here is staff-only. The rows behind them
 * carry full PII (name, DOB, government ID number, phone, address,
 * monthly income) and `monthlyIncome` feeds credit scoring and
 * affordability, so the write paths are a decisioning input, not just
 * a record edit. Borrowers reach their own record through
 * `/api/v1/portal/me`, which derives the customer id from the JWT
 * subject — nothing here is customer-reachable.
 *
 *   customers.read   — LOAN_OFFICER, ACCOUNTANT, ADMIN
 *   customers.write  — LOAN_OFFICER, ADMIN
 */
export function registerCustomerHttp(
  app: FastifyInstance,
  controller: CustomerController,
): void {
  app.get(
    "/",
    {
      preHandler: app.requirePermission("customers.read"),
      schema: routeSchema({
        summary:
          "Customers, newest first, with live-loan and defaulted markers. " +
          "Archived rows are excluded unless asked for.",
        tags: TAGS,
        querystring: customerListQuerySchema,
        response: customerListResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    controller.list,
  );
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("customers.read"),
      schema: routeSchema({
        summary: "One customer, by id or CUST- number.",
        tags: TAGS,
        params: customerIdParamSchema,
        response: customerResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    controller.show,
  );
  app.post(
    "/",
    {
      preHandler: app.requirePermission("customers.write"),
      schema: routeSchema({
        summary:
          "Register a customer. AML screening kicks off best-effort after " +
          "the row commits.",
        tags: TAGS,
        body: customerSchema,
        response: customerResponseSchema,
        status: 201,
        errors: [400, 401, 403],
      }),
    },
    controller.create,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/summary",
    {
      preHandler: app.requirePermission("customers.read"),
      schema: routeSchema({
        summary:
          "Side-drawer rollup: the record plus live loans and outstanding.",
        tags: TAGS,
        params: customerIdParamSchema,
        response: customerSummaryResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    controller.summary,
  );
  /*
   * Consolidated exposure across every loan this customer holds.
   *
   * `customers.read` rather than a key of its own: the response is a
   * rollup of loans the same roles already read one at a time, and
   * inventing a permission nobody is granted would leave the panel
   * 403ing for the officers it exists for.
   */
  app.get<{ Params: { id: string } }>(
    "/:id/exposure",
    {
      preHandler: app.requirePermission("customers.read"),
      schema: routeSchema({
        summary:
          "What the lender is into this borrower for, across every loan — " +
          "arrears separate, exclusions named.",
        tags: TAGS,
        params: customerIdParamSchema,
        response: customerExposureResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    controller.exposure,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/repeat-eligibility",
    {
      preHandler: app.requirePermission("customers.read"),
      schema: routeSchema({
        summary:
          "Repeat-borrower check: a closed loan on file and no defaults.",
        tags: TAGS,
        params: customerIdParamSchema,
        response: repeatEligibilityResponseSchema,
        errors: [401, 403, 404],
      }),
    },
    controller.repeatEligibility,
  );
  app.patch<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: app.requirePermission("customers.write"),
      schema: routeSchema({
        summary:
          "Patch the record. Phone rules validate on CHANGE against what " +
          "is stored, not on presence.",
        tags: TAGS,
        params: customerIdParamSchema,
        body: customerBaseSchema.partial(),
        response: customerResponseSchema,
        // 409 is a privacy-erased record — closed to edits for good.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    controller.update,
  );

  /*
   * Archive / restore — the soft delete. There is no DELETE route on
   * purpose: a customer anchors loans, payments, contributions and
   * ledger lines, and the member register is itself a record the
   * cooperative has to keep.
   */
  app.patch<{ Params: { id: string } }>(
    "/:id/archive",
    {
      preHandler: app.requirePermission("customers.archive"),
      schema: routeSchema({
        summary:
          "File a customer away, or restore them. Idempotent in both " +
          "directions.",
        tags: TAGS,
        params: customerIdParamSchema,
        body: archiveCustomerSchema,
        response: archiveCustomerResponseSchema,
        // 409 names the open loans standing in the way of archiving.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    controller.setArchived,
  );
}
