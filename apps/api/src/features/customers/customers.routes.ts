import type { FastifyInstance } from "fastify";

import type { CustomerController } from "./customers.controller.js";

/**
 * HTTP wiring for the base customer CRUD surface. This file is
 * intentionally trivial — each endpoint just maps method+path onto a
 * controller method. The interesting code lives in the controller +
 * service.
 *
 * URL convention: `:id` accepts either the UUID or the human
 * "CUST-2026-..." reference number. The frontend navigates via the
 * number; UUIDs still resolve for back-compat with old links.
 */
export function registerCustomerHttp(
  app: FastifyInstance,
  controller: CustomerController,
): void {
  app.get("/", controller.list);
  app.get<{ Params: { id: string } }>("/:id", controller.show);
  app.post("/", controller.create);
  app.get<{ Params: { id: string } }>("/:id/summary", controller.summary);
  app.get<{ Params: { id: string } }>(
    "/:id/repeat-eligibility",
    controller.repeatEligibility,
  );
  app.patch<{ Params: { id: string } }>("/:id", controller.update);
}
