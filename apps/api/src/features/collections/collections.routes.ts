/**
 * Collections routes — overdue queue, contact notes, promises-to-pay,
 * + the late-fee accrual job.
 *
 *   GET  /collections/queue                          any authenticated
 *   GET  /collections/loans/:loanId/notes            any authenticated
 *   POST /collections/loans/:loanId/notes            any authenticated
 *   GET  /collections/loans/:loanId/promises         any authenticated
 *   POST /collections/loans/:loanId/promises         any authenticated
 *   POST /collections/promises/:id/resolve           any authenticated
 *   POST /collections/jobs/accrue-late-fees          collections.accrue
 *
 * Layered: routes → controller → service → repo. The accrual job
 * surfaces fee-accrual failures (closed period, missing CoA) as a 409
 * — the request was valid, the world just isn't ready.
 *
 * Phase 2: per-request service wiring via `req.collectionsServices`.
 */

import { CollectionsRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { CollectionsController } from "./collections.controller";
import { CollectionsService } from "./collections.service";

declare module "fastify" {
  interface FastifyRequest {
    collectionsServices?: { collections: CollectionsService };
  }
}

export async function collectionsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.collectionsServices = {
      collections: new CollectionsService(
        new CollectionsRepository(req.tenantCtx.prisma),
      ),
    };
  });

  const ctrl = new CollectionsController();

  app.get("/queue", ctrl.queue);

  app.get<{ Params: { loanId: string } }>(
    "/loans/:loanId/notes",
    ctrl.listNotes,
  );
  app.post<{ Params: { loanId: string } }>(
    "/loans/:loanId/notes",
    ctrl.addNote,
  );

  app.get<{ Params: { loanId: string } }>(
    "/loans/:loanId/promises",
    ctrl.listPromises,
  );
  app.post<{ Params: { loanId: string } }>(
    "/loans/:loanId/promises",
    ctrl.createPromise,
  );
  app.post<{ Params: { id: string } }>(
    "/promises/:id/resolve",
    ctrl.resolvePromise,
  );

  app.post(
    "/jobs/accrue-late-fees",
    { preHandler: app.requirePermission("collections.accrue") },
    ctrl.accrueLateFees,
  );
}
