import type { FastifyInstance } from "fastify";

import type { LedgerQuery } from "./schemas";
import type { CustomerLedgerController } from "./ledger.controller";

/**
 * HTTP wiring for the customer ledger surface. Three endpoints share
 * the same `:id` resolution (UUID or CUST-… number); the controller
 * handles 404 mapping and format negotiation.
 */
export function registerLedgerHttp(
  app: FastifyInstance,
  controller: CustomerLedgerController,
): void {
  app.get<{ Params: { id: string }; Querystring: LedgerQuery }>(
    "/:id/ledger",
    controller.json,
  );
  app.get<{ Params: { id: string }; Querystring: LedgerQuery }>(
    "/:id/ledger.pdf",
    controller.pdf,
  );
  app.post<{ Params: { id: string } }>("/:id/ledger/email", controller.email);
}
