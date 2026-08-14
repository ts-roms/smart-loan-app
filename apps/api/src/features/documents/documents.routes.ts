/**
 * Document streaming routes — agreement, statement of account, receipt.
 *
 * Phase 2: per-request service wiring via `req.documentsServices`.
 * Both the officer surface and the portal mirror share the same
 * preHandler factory.
 *
 * ## Two surfaces, two authorization models
 *
 * The officer routes take a loan identifier straight off the path and
 * `DocumentsService` performs NO ownership check on them — `actorId` is
 * used only to resolve the optional `?sign=1` personnel signature. Loan
 * numbers are sequential ("LN-2026-000123"), so the identifier space is
 * trivially enumerable: without a gate, any authenticated account could
 * walk the range and pull every borrower's signed agreement (which
 * prints the government ID block) and statement of account.
 *
 * The gate is `documents.download`, held by LOAN_OFFICER, ACCOUNTANT
 * and ADMIN — i.e. exactly the staff whose job is to pull a document
 * for a borrower they're servicing. That is the "or require
 * documents.download" half of the scope contract; there is no
 * per-officer loan assignment model in the schema to scope against
 * (no `LoanApplication.assignedOfficerId`), so a narrower ownership
 * check isn't expressible here today.
 *
 * The portal mirror stays ungated by permission on purpose: it runs
 * `resolveCustomer` (JWT sub → User.customerId, CUSTOMER role only)
 * and every `portal*` service method re-checks
 * `loan.customerId === customerId` before rendering a byte. Ownership
 * IS the authorization there, so `portal.self` would be redundant
 * ceremony on top of a check that already can't be bypassed.
 *
 * ## Why NONE of these six carry a response schema
 *
 * Every route in this file answers `application/pdf` bytes — see
 * `sendPdf` in helpers.ts, which sets the content type and writes a
 * Buffer. `routeSchema` describes an `application/json` body and
 * nothing else, so there are exactly two things it could say here and
 * both are false: a JSON object shape these routes never send, or (by
 * omitting `response`) a `204 No body` for a call whose entire purpose
 * is the body.
 *
 * So they are deliberately blank, on the same grounds as
 * `portal/ledger.pdf` and `customers/:id/ledger.pdf`. This is the
 * documented exception, not an unfinished corner — describing a PDF
 * stream needs a non-JSON content-type slot in `routeSchema`, which is
 * a change to the mechanism rather than to these routes.
 *
 * The 404 they can answer (unknown loan, or a portal caller asking for
 * someone else's loan) is real but cannot be declared on its own:
 * `errors` only ever appears alongside a described success.
 */

import { LoanRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";

declare module "fastify" {
  interface FastifyRequest {
    documentsServices?: { documents: DocumentsService };
  }
}

function buildDocsCtx() {
  return async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.documentsServices = {
      documents: new DocumentsService(prisma, new LoanRepository(prisma)),
    };
  };
}

export async function documentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", buildDocsCtx());

  const ctrl = new DocumentsController();
  const download = { preHandler: app.requirePermission("documents.download") };

  app.get<{ Params: { id: string } }>(
    "/loans/:id/agreement.pdf",
    download,
    ctrl.agreement,
  );

  app.get<{ Params: { id: string } }>(
    "/loans/:id/statement.pdf",
    download,
    ctrl.statement,
  );

  app.get<{ Params: { loanId: string; paymentId: string } }>(
    "/loans/:loanId/payments/:paymentId/receipt.pdf",
    download,
    ctrl.receipt,
  );
}

/**
 * Portal mirror — mounted under `/api/v1/portal`. Auth is already
 * applied by `portalRoutes`; we re-resolve the customer here to make
 * sure the user can only download their own.
 */
export async function portalDocumentRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", buildDocsCtx());

  const ctrl = new DocumentsController();

  app.get<{ Params: { id: string } }>(
    "/loans/:id/agreement.pdf",
    ctrl.portalAgreement,
  );

  app.get<{ Params: { id: string } }>(
    "/loans/:id/statement.pdf",
    ctrl.portalStatement,
  );

  app.get<{ Params: { loanId: string; paymentId: string } }>(
    "/loans/:loanId/payments/:paymentId/receipt.pdf",
    ctrl.portalReceipt,
  );
}
