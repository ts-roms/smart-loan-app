import type { FastifyInstance } from "fastify";

import type { BulkImportController } from "./bulk-import.controller";

/**
 * HTTP wiring for bulk customer import. Single endpoint mounted under
 * the customers prefix; gated behind `customers.write` so only roles
 * that can create individual customers can also create them in bulk.
 */
export function registerBulkImportHttp(
  app: FastifyInstance,
  controller: BulkImportController,
): void {
  app.post(
    "/bulk",
    {
      preHandler: [
        app.requireFeature("bulk.customers"),
        app.requirePermission("customers.write"),
      ],
    },
    controller.run,
  );
}
