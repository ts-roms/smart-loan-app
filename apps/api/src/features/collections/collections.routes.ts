/**
 * Collections routes — overdue queue, contact notes, promises-to-pay,
 * + the late-fee accrual job.
 *
 *   GET  /collections/queue?scope=all|mine|unassigned collections.read
 *   GET  /collections/collectors                     collections.read
 *   GET  /collections/workload                       collections.read
 *   PUT  /collections/loans/:loanId/assignee         collections.assign
 *   DELETE /collections/loans/:loanId/assignee       collections.assign
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
 * Assignment is separated from working an account. A collector holds
 * `collections.note` but NOT `collections.assign` — someone who can hand
 * accounts to themselves can cherry-pick the collectible ones and leave
 * the hard book to everyone else. Handing work out belongs to whoever
 * is accountable for the spread, so it sits with LOAN_OFFICER and ADMIN.
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
        req.tenantCtx.prisma.user,
        req.tenantCtx.prisma.loanApplication,
      ),
    };
  });

  const ctrl = new CollectionsController();
  const read = { preHandler: app.requirePermission("collections.read") };
  const note = { preHandler: app.requirePermission("collections.note") };
  const assign = { preHandler: app.requirePermission("collections.assign") };

  app.get<{ Querystring: { scope?: string } }>("/queue", read, ctrl.queue);

  // Reads, not writes: a collector needs the roster to see who else
  // holds what, and the queue already names the current assignee.
  app.get("/collectors", read, ctrl.assignableCollectors);
  app.get("/workload", read, ctrl.workload);

  // PUT, not POST: assigning is idempotent and names the same resource
  // every time — one loan has one assignee.
  app.put<{ Params: { loanId: string } }>(
    "/loans/:loanId/assignee",
    assign,
    ctrl.assign,
  );
  app.delete<{ Params: { loanId: string } }>(
    "/loans/:loanId/assignee",
    assign,
    ctrl.unassign,
  );
  // POST, not PUT: unlike the per-loan assignee this doesn't name a
  // single resource — it's a batch action over whatever the supervisor
  // filtered ("everything overdue in Bulacan → Ana").
  app.post("/assignees/bulk", assign, ctrl.assignBulk);

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
