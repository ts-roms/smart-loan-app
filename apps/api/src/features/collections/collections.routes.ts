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

import { routeSchema } from "../../lib/openapi";
import { CollectionsController } from "./collections.controller";
import { CollectionsService } from "./collections.service";
import {
  accrueLateFeesResponseSchema,
  assignSchema,
  assignmentResponseSchema,
  bulkAssignResponseSchema,
  bulkAssignSchema,
  collectorListResponseSchema,
  loanIdParamSchema,
  noteListResponseSchema,
  noteResponseSchema,
  noteSchema,
  promiseIdParamSchema,
  promiseListResponseSchema,
  promiseResponseSchema,
  ptpSchema,
  queueResponseSchema,
  queueScopeSchema,
  resolveSchema,
  workloadResponseSchema,
} from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    collectionsServices?: { collections: CollectionsService };
  }
}

const TAGS = ["collections"];

export async function collectionsRoutes(app: FastifyInstance) {
  // onRequest, not preHandler — routes here carry request schemas, and
  // Fastify validates before preHandler; authentication has to come
  // first or an anonymous caller with a bad body gets a 400 instead of
  // a 401. See decision-rules.routes.ts for the full account.
  app.addHook("onRequest", app.authenticate);
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

  app.get<{ Querystring: { scope?: string } }>(
    "/queue",
    {
      ...read,
      schema: routeSchema({
        summary:
          "Delinquent accounts by §29 collection priority. scope=mine is " +
          "the caller's own book; unassigned is the hand-out pool.",
        tags: TAGS,
        querystring: queueScopeSchema,
        response: queueResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.queue,
  );

  // Reads, not writes: a collector needs the roster to see who else
  // holds what, and the queue already names the current assignee.
  app.get(
    "/collectors",
    {
      ...read,
      schema: routeSchema({
        summary: "Active users who can hold accounts — the assign picker.",
        tags: TAGS,
        response: collectorListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.assignableCollectors,
  );
  app.get(
    "/workload",
    {
      ...read,
      schema: routeSchema({
        summary: "Accounts carried per collector, busiest first.",
        tags: TAGS,
        response: workloadResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.workload,
  );

  // PUT, not POST: assigning is idempotent and names the same resource
  // every time — one loan has one assignee.
  app.put<{ Params: { loanId: string } }>(
    "/loans/:loanId/assignee",
    {
      ...assign,
      schema: routeSchema({
        summary:
          "Hand the account to a collector (UUID or email), or move it. " +
          "An unknown or deactivated collector answers 422.",
        tags: TAGS,
        params: loanIdParamSchema,
        body: assignSchema,
        response: assignmentResponseSchema,
        // 422 (collector can't take the work) is also returned but has
        // no shared component; see the controller.
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.assign,
  );
  app.delete<{ Params: { loanId: string } }>(
    "/loans/:loanId/assignee",
    {
      ...assign,
      schema: routeSchema({
        summary:
          "Return the account to the unassigned pool. 204 even when " +
          "nothing was assigned.",
        tags: TAGS,
        params: loanIdParamSchema,
        errors: [401, 403],
      }),
    },
    ctrl.unassign,
  );
  // POST, not PUT: unlike the per-loan assignee this doesn't name a
  // single resource — it's a batch action over whatever the supervisor
  // filtered ("everything overdue in Bulacan → Ana").
  app.post(
    "/assignees/bulk",
    {
      ...assign,
      schema: routeSchema({
        summary:
          "Hand up to 500 accounts to one collector. Unknown loan ids " +
          "come back in `missing` rather than failing the batch.",
        tags: TAGS,
        body: bulkAssignSchema,
        response: bulkAssignResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.assignBulk,
  );

  app.get<{ Params: { loanId: string } }>(
    "/loans/:loanId/notes",
    {
      ...read,
      schema: routeSchema({
        summary: "Contact history on the account, newest first. Capped at 100.",
        tags: TAGS,
        params: loanIdParamSchema,
        response: noteListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listNotes,
  );
  app.post<{ Params: { loanId: string } }>(
    "/loans/:loanId/notes",
    {
      ...note,
      schema: routeSchema({
        summary: "Log a borrower contact (call, SMS, email, visit).",
        tags: TAGS,
        params: loanIdParamSchema,
        body: noteSchema,
        response: noteResponseSchema,
        status: 201,
        errors: [400, 401, 403],
      }),
    },
    ctrl.addNote,
  );

  app.get<{ Params: { loanId: string } }>(
    "/loans/:loanId/promises",
    {
      ...read,
      schema: routeSchema({
        summary: "Promises to pay on the account, latest promise first.",
        tags: TAGS,
        params: loanIdParamSchema,
        response: promiseListResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.listPromises,
  );
  app.post<{ Params: { loanId: string } }>(
    "/loans/:loanId/promises",
    {
      ...note,
      schema: routeSchema({
        summary: "Record a promise to pay.",
        tags: TAGS,
        params: loanIdParamSchema,
        body: ptpSchema,
        response: promiseResponseSchema,
        status: 201,
        errors: [400, 401, 403],
      }),
    },
    ctrl.createPromise,
  );
  app.post<{ Params: { id: string } }>(
    "/promises/:id/resolve",
    {
      ...note,
      schema: routeSchema({
        summary: "Close a promise out: honored, broken, or cancelled.",
        tags: TAGS,
        params: promiseIdParamSchema,
        body: resolveSchema,
        response: promiseResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.resolvePromise,
  );

  app.post(
    "/jobs/accrue-late-fees",
    {
      preHandler: app.requirePermission("collections.accrue"),
      schema: routeSchema({
        summary:
          "Accrue today's late fees across the book. Idempotent per " +
          "instalment and day.",
        tags: TAGS,
        response: accrueLateFeesResponseSchema,
        // 409 is the house meaning: a closed period or a missing account
        // in the chart refused the posting. Retrying unchanged fails the
        // same way.
        errors: [401, 403, 409],
      }),
    },
    ctrl.accrueLateFees,
  );
}
