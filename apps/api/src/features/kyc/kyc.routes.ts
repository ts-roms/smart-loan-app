import type { FastifyInstance } from "fastify";

import type { KycController } from "./kyc.controller";

/**
 * HTTP wiring for the KYC surface. All endpoints sit under /kyc; the
 * customer-scoped status endpoint uses /kyc/customers/:customerId/status
 * so it doesn't collide with /kyc/:id.
 *
 * Authorization mirrors the three KYC permissions:
 *
 *   GET  /                              kyc.read
 *   GET  /customers/:customerId/status  kyc.read
 *   POST /                              kyc.submit
 *   POST /:id/decide                    kyc.decide
 *
 * These are the officer-side routes — they take a customerId from the
 * request, so a borrower reaching them could read (or file) documents
 * against anyone. The borrower's own submission path is
 * `/api/v1/portal/kyc`, which resolves the customer from the JWT sub.
 */
export function registerKycHttp(
  app: FastifyInstance,
  controller: KycController,
): void {
  app.get<{ Querystring: { customerId?: string } }>(
    "/",
    { preHandler: app.requirePermission("kyc.read") },
    controller.list,
  );
  /*
   * The review queue. Declared before "/:id/decide" and separate from
   * "/" because "/" demands a customerId — which is precisely why the
   * console used to fetch every customer and then ask about each one
   * individually.
   */
  app.get<{ Querystring: { page?: string; pageSize?: string } }>(
    "/pending",
    { preHandler: app.requirePermission("kyc.read") },
    controller.listPending,
  );
  app.post(
    "/",
    { preHandler: app.requirePermission("kyc.submit") },
    controller.submit,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/decide",
    { preHandler: app.requirePermission("kyc.decide") },
    controller.decide,
  );
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/status",
    { preHandler: app.requirePermission("kyc.read") },
    controller.status,
  );
}
