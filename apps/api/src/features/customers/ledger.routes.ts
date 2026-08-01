import type { FastifyInstance } from "fastify";

import type { LedgerQuery } from "./schemas";
import type { CustomerLedgerController } from "./ledger.controller";

/**
 * HTTP wiring for the customer ledger surface. Three endpoints share
 * the same `:id` resolution (UUID or CUST-… number); the controller
 * handles 404 mapping and format negotiation.
 *
 * Authorization: `customers.read` on all three. The ledger is another
 * customer's financial history keyed by a path parameter, so it needs
 * the same staff gate as the rest of the customers feature. The email
 * variant stays on `customers.read` rather than `customers.write` —
 * it mails the statement to the customer on file (no operator-supplied
 * recipient, no record mutation), and the accountant who typically
 * sends it holds read but not write.
 *
 * Borrowers get their own ledger via `/api/v1/portal/me/ledger`,
 * which resolves the customer id from the JWT subject.
 */
export function registerLedgerHttp(
  app: FastifyInstance,
  controller: CustomerLedgerController,
): void {
  app.get<{ Params: { id: string }; Querystring: LedgerQuery }>(
    "/:id/ledger",
    { preHandler: app.requirePermission("customers.read") },
    controller.json,
  );
  app.get<{ Params: { id: string }; Querystring: LedgerQuery }>(
    "/:id/ledger.pdf",
    { preHandler: app.requirePermission("customers.read") },
    controller.pdf,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/ledger/email",
    { preHandler: app.requirePermission("customers.read") },
    controller.email,
  );
}
