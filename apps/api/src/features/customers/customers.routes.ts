import type { FastifyInstance } from "fastify";

import type { CustomerController } from "./customers.controller";

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
    { preHandler: app.requirePermission("customers.read") },
    controller.list,
  );
  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("customers.read") },
    controller.show,
  );
  app.post(
    "/",
    { preHandler: app.requirePermission("customers.write") },
    controller.create,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/summary",
    { preHandler: app.requirePermission("customers.read") },
    controller.summary,
  );
  app.get<{ Params: { id: string } }>(
    "/:id/repeat-eligibility",
    { preHandler: app.requirePermission("customers.read") },
    controller.repeatEligibility,
  );
  app.patch<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("customers.write") },
    controller.update,
  );

  // Its own permission, not customers.write — see the catalog entry.
  // The endpoint refuses anyone with financial history, so this is the
  // duplicate-record escape hatch rather than a way to lose a borrower.
  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("customers.delete") },
    controller.remove,
  );
}
