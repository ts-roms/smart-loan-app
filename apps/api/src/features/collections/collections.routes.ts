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
 */

import { CollectionsRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { CollectionsController } from "./collections.controller.js";
import { CollectionsService } from "./collections.service.js";

export async function collectionsRoutes(app: FastifyInstance) {
  const ctrl = new CollectionsController(
    new CollectionsService(new CollectionsRepository(app.prisma)),
  );
  app.addHook("preHandler", app.authenticate);

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
