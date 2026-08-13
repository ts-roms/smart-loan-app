import type { FastifyInstance } from "fastify";

import { routeSchema } from "../../lib/openapi";
import type { LedgerQuery } from "./schemas";
import type { CustomerLedgerController } from "./ledger.controller";
import {
  customerIdParamSchema,
  customerLedgerResponseSchema,
  statementEmailResponseSchema,
} from "./schemas";

const TAGS = ["customers"];

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
    {
      preHandler: app.requirePermission("customers.read"),
      schema: routeSchema({
        summary:
          "Unified statement of account (loans + coop activity). " +
          "`?format=csv` streams CSV instead; the schema describes the " +
          "JSON shape. No query schema — `from`/`to` are validated by " +
          "hand so date-only values keep working.",
        tags: TAGS,
        params: customerIdParamSchema,
        response: customerLedgerResponseSchema,
        // 400 is an unparseable from/to.
        errors: [400, 401, 403, 404],
      }),
    },
    controller.json,
  );
  /*
   * No schema on ledger.pdf: it answers `application/pdf` bytes, and
   * routeSchema can only describe an application/json body. Publishing
   * a JSON shape it never sends — or the 204 an omitted response would
   * claim — beats nothing only if it were true.
   */
  app.get<{ Params: { id: string }; Querystring: LedgerQuery }>(
    "/:id/ledger.pdf",
    { preHandler: app.requirePermission("customers.read") },
    controller.pdf,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/ledger/email",
    {
      preHandler: app.requirePermission("customers.read"),
      schema: routeSchema({
        summary:
          "Dispatch a statement-ready notification — in-app always, email " +
          "when one is on file. The PDF is never attached.",
        tags: TAGS,
        params: customerIdParamSchema,
        response: statementEmailResponseSchema,
        status: 202,
        errors: [401, 403, 404],
      }),
    },
    controller.email,
  );
}
