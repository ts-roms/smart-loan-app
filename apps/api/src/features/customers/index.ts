import {
  AuditLogRepository,
  CustomerExposureRepository,
  CustomerLedgerRepository,
  CustomerRepository,
} from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { BulkImportController } from "./bulk-import.controller";
import { BulkImportService } from "./bulk-import.service";
import { registerBulkImportHttp } from "./bulk-import.routes";
import { CustomerController } from "./customers.controller";
import { registerCustomerHttp } from "./customers.routes";
import { CustomerService } from "./customers.service";
import { CustomerLedgerController } from "./ledger.controller";
import { registerLedgerHttp } from "./ledger.routes";
import { CustomerLedgerService } from "./ledger.service";

/**
 * Customers feature entry point — registered by the central router
 * under the `/customers` prefix.
 *
 * **Phase 2 canary**: this feature is the first to use the
 * per-request, tenant-scoped service wiring. The pattern is:
 *
 *   1. `app.authenticate` verifies the JWT and sets `req.user`.
 *   2. `app.resolveTenant` reads the JWT's `tenant` claim (in
 *      multi-tenant mode) and binds a Prisma client whose pool is
 *      pinned to that tenant's schema. In single-tenant mode it just
 *      points at `app.prisma`. Either way, `req.tenantCtx.prisma` is
 *      what every subsequent query should use.
 *   3. `buildCustomerServices` instantiates repos + services using
 *      that bound client, stashing the result on `req.customerServices`.
 *   4. Controllers read services from `req.customerServices` rather
 *      than capturing them in their constructors. This keeps the
 *      controller-as-singleton pattern intact while letting the
 *      service dependencies vary per request.
 *
 * Cost is ~5 µs of object allocation per request — negligible
 * compared to any real DB query. The win is leak-safety: every
 * service is built on top of a tenant-bound client, so there's no
 * code path that can query the wrong schema.
 *
 * @see docs/multi-tenant-implementation.md §4
 */

/**
 * Per-request service container for the customers feature. Populated
 * by `buildCustomerServices` and consumed by every controller in
 * this folder.
 */
export interface CustomerServices {
  customer: CustomerService;
  bulkImport: BulkImportService;
  ledger: CustomerLedgerService;
}

declare module "fastify" {
  interface FastifyRequest {
    customerServices?: CustomerServices;
  }
}

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // Order matters: authenticate → resolveTenant → build services.
  // Each preHandler depends on what the previous one set.
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", buildCustomerServices(app));

  // Controllers are now stateless — they read services from req.
  // We keep them as singletons since constructing them is free and
  // route registration takes a controller reference.
  const customerController = new CustomerController();
  const bulkImportController = new BulkImportController();
  const ledgerController = new CustomerLedgerController();

  registerCustomerHttp(app, customerController);
  registerBulkImportHttp(app, bulkImportController);
  registerLedgerHttp(app, ledgerController);
}

/**
 * Per-request service factory. Returns a preHandler that builds the
 * customer service tree on top of `req.tenantCtx.prisma` and stores
 * it on the request.
 *
 * Lives outside `customerRoutes` so tests can exercise the wiring
 * directly (build a fake request, call the returned function, assert
 * on the resulting `req.customerServices`).
 */
function buildCustomerServices(app: FastifyInstance) {
  return async (req: FastifyRequest) => {
    const { prisma } = req.tenantCtx;
    const customerRepo = new CustomerRepository(prisma);
    const ledgerRepo = new CustomerLedgerRepository(prisma);
    const screening = app.screening(prisma);
    const notifications = app.notifications(prisma);
    req.customerServices = {
      customer: new CustomerService(
        customerRepo,
        prisma,
        screening,
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
        new CustomerExposureRepository(prisma),
      ),
      bulkImport: new BulkImportService(customerRepo, screening),
      ledger: new CustomerLedgerService(
        customerRepo,
        ledgerRepo,
        notifications,
        prisma,
      ),
    };
  };
}
