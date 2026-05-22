import type { FastifyInstance } from "fastify";

import type { KycController } from "./kyc.controller.js";

/**
 * HTTP wiring for the KYC surface. All endpoints sit under /kyc; the
 * customer-scoped status endpoint uses /kyc/customers/:customerId/status
 * so it doesn't collide with /kyc/:id.
 */
export function registerKycHttp(
  app: FastifyInstance,
  controller: KycController,
): void {
  app.get<{ Querystring: { customerId?: string } }>("/", controller.list);
  app.post("/", controller.submit);
  app.post<{ Params: { id: string } }>("/:id/decide", controller.decide);
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/status",
    controller.status,
  );
}
