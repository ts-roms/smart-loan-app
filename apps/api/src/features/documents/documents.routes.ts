/**
 * Document streaming routes — agreement, statement of account, receipt.
 *
 * Phase 2: per-request service wiring via `req.documentsServices`.
 * Both the officer surface and the portal mirror share the same
 * preHandler factory.
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
