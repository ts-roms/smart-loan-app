/**
 * Document streaming routes — agreement, statement of account, receipt.
 *
 * All three are generated on demand from the loan + schedule + payments
 * already in the DB. Nothing is persisted; the PDF is built in memory
 * and piped back as `application/pdf` with `inline` disposition so the
 * browser previews it in a tab.
 *
 * Two surfaces:
 *   - Officer: any loan readable; supports `?sign=1` to embed the
 *     caller's saved personnel signature.
 *   - Portal mirror: scoped to the customer's own loans; no `?sign=1`.
 *
 * Layered: routes → controller → service (looks up loan + branding +
 * signature bytes, builds the renderer args). The same shape helpers
 * live on the service so officer + portal don't drift apart.
 */

import { LoanRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";

function makeController(app: FastifyInstance): DocumentsController {
  return new DocumentsController(
    new DocumentsService(app.prisma, new LoanRepository(app.prisma)),
    app.prisma,
  );
}

export async function documentRoutes(app: FastifyInstance) {
  const ctrl = makeController(app);
  app.addHook("preHandler", app.authenticate);

  app.get<{ Params: { id: string } }>(
    "/loans/:id/agreement.pdf",
    ctrl.agreement,
  );

  app.get<{ Params: { id: string } }>(
    "/loans/:id/statement.pdf",
    ctrl.statement,
  );

  app.get<{ Params: { loanId: string; paymentId: string } }>(
    "/loans/:loanId/payments/:paymentId/receipt.pdf",
    ctrl.receipt,
  );
}

/**
 * Portal mirror — mounted under `/api/v1/portal`. Auth is already
 * applied by `portalRoutes`; we re-resolve the customer here to make
 * sure the user can only download their own.
 */
export async function portalDocumentRoutes(app: FastifyInstance) {
  const ctrl = makeController(app);
  app.addHook("preHandler", app.authenticate);

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
