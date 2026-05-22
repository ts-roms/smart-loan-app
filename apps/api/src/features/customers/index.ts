import { CustomerLedgerRepository, CustomerRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

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
 * Wires up the three sub-surfaces (CRUD, bulk-import, ledger) using
 * shared repositories and the cross-cutting `app.screening` /
 * `app.notifications` decorators. Each sub-surface owns its own
 * controller and service; everything else here is plumbing.
 */
export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // Infrastructure
  const customerRepo = new CustomerRepository(app.prisma);
  const ledgerRepo = new CustomerLedgerRepository(app.prisma);

  // Application services
  const customerService = new CustomerService(
    customerRepo,
    app.prisma,
    app.screening,
  );
  const bulkImportService = new BulkImportService(customerRepo, app.screening);
  const ledgerService = new CustomerLedgerService(
    customerRepo,
    ledgerRepo,
    app.notifications,
    app.prisma,
  );

  // Presentation
  const customerController = new CustomerController(customerService);
  const bulkImportController = new BulkImportController(bulkImportService);
  const ledgerController = new CustomerLedgerController(ledgerService);

  // Every customer route requires authentication. Mounted once at the
  // feature level rather than per-route file to keep route files focused
  // on URL mapping.
  app.addHook("preHandler", app.authenticate);

  // Route registration. Order matters only when paths overlap; here the
  // three groups have disjoint shapes (`/`, `/bulk`, `/:id/...`) so the
  // order is just for readability.
  registerCustomerHttp(app, customerController);
  registerBulkImportHttp(app, bulkImportController);
  registerLedgerHttp(app, ledgerController);
}
