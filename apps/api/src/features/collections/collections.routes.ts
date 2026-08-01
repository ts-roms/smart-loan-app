/**
 * Collections routes — overdue queue, contact notes, promises-to-pay,
 * + the late-fee accrual job.
 *
 *   GET  /collections/queue                          collections.read
 *   GET  /collections/loans/:loanId/notes            collections.read
 *   POST /collections/loans/:loanId/notes            collections.note
 *   GET  /collections/loans/:loanId/promises         collections.read
 *   POST /collections/loans/:loanId/promises         collections.note
 *   POST /collections/promises/:id/resolve           collections.note
 *   POST /collections/jobs/accrue-late-fees          collections.accrue
 *
 * The queue is every delinquent borrower in the book (name, balance,
 * days past due) and the notes carry contact history, so the reads
 * take `collections.read` — LOAN_OFFICER, ACCOUNTANT, ADMIN. Writing a
 * note or a promise-to-pay takes `collections.note`, which ACCOUNTANT
 * deliberately does not hold: recording what a borrower said is the
 * collector's job, not the bookkeeper's.
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
  const read = { preHandler: app.requirePermission("collections.read") };
  const note = { preHandler: app.requirePermission("collections.note") };

  app.get("/queue", read, ctrl.queue);

  app.get<{ Params: { loanId: string } }>(
    "/loans/:loanId/notes",
    read,
    ctrl.listNotes,
  );
  app.post<{ Params: { loanId: string } }>(
    "/loans/:loanId/notes",
    note,
    ctrl.addNote,
  );

  app.get<{ Params: { loanId: string } }>(
    "/loans/:loanId/promises",
    read,
    ctrl.listPromises,
  );
  app.post<{ Params: { loanId: string } }>(
    "/loans/:loanId/promises",
    note,
    ctrl.createPromise,
  );
  app.post<{ Params: { id: string } }>(
    "/promises/:id/resolve",
    note,
    ctrl.resolvePromise,
  );

  app.post(
    "/jobs/accrue-late-fees",
    { preHandler: app.requirePermission("collections.accrue") },
    ctrl.accrueLateFees,
  );
}
