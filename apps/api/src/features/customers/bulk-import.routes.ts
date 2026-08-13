import type { FastifyInstance } from "fastify";

import { routeSchema } from "../../lib/openapi";
import type { BulkImportController } from "./bulk-import.controller";
import { bulkImportResponseSchema, bulkImportSchema } from "./schemas";

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
      schema: routeSchema({
        summary:
          "Import up to 500 customers. Rows commit independently; the 207 " +
          "reports each row in CSV order. dryRun previews validation only.",
        tags: ["customers"],
        body: bulkImportSchema,
        response: bulkImportResponseSchema,
        status: 207,
        errors: [400, 401, 402, 403],
      }),
    },
    controller.run,
  );
}
