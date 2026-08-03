/**
 * Annual / renewable document tracker.
 *
 *   GET  /loans/:loanId/annual-docs         loans.read
 *   POST /loans/:loanId/annual-docs         loans.docs_renew
 *   DELETE /annual-docs/:id                 loans.docs_renew
 *   GET  /annual-docs/expiring?days=30      loans.read
 *
 * Status is recomputed nightly by the scheduled job (see jobs.ts —
 * annual_doc_status_refresh). Phase 2: per-request repo wiring against
 * `req.tenantCtx.prisma`.
 */

import { AnnualDocumentRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { createSchema, listExpiringQuerySchema } from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    annualDocsRepo?: AnnualDocumentRepository;
  }
}

function attachAnnualDocsRepo() {
  return async (req: FastifyRequest) => {
    req.annualDocsRepo = new AnnualDocumentRepository(req.tenantCtx.prisma);
  };
}

export async function annualDocsLoanRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // Annual / renewable docs are a PROFESSIONAL-tier feature. The gate
  // reads req.tenantCtx, so resolveTenant must run before it.
  app.addHook("preHandler", app.requireFeature("compliance.annual_docs"));
  app.addHook("preHandler", attachAnnualDocsRepo());

  app.get<{ Params: { loanId: string } }>(
    "/:loanId/annual-docs",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => req.annualDocsRepo!.listForLoan(req.params.loanId),
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/annual-docs",
    { preHandler: app.requirePermission("loans.docs_renew") },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const created = await req.annualDocsRepo!.create({
          loanId: req.params.loanId,
          type: parsed.data.type,
          name: parsed.data.name,
          documentUrl: parsed.data.documentUrl,
          effectiveFrom: new Date(parsed.data.effectiveFrom),
          expiresAt: new Date(parsed.data.expiresAt),
          notes: parsed.data.notes,
          submittedById: req.user.sub,
        });
        return reply.code(201).send(created);
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );
}

/** Cross-loan endpoints — separate prefix so the route shapes stay clean. */
export async function annualDocsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", app.requireFeature("compliance.annual_docs"));
  app.addHook("preHandler", attachAnnualDocsRepo());

  app.get(
    "/expiring",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const parsed = listExpiringQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return req.annualDocsRepo!.listExpiring(parsed.data.days ?? 30);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("loans.docs_renew") },
    async (req, reply) => {
      try {
        await req.annualDocsRepo!.remove(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );

  /**
   * Manual trigger for the status refresh — useful for testing and for
   * the operations dashboard. The scheduled job runs this on a cron.
   */
  app.post(
    "/jobs/refresh-statuses",
    { preHandler: app.requirePermission("loans.docs_renew") },
    async (req) => req.annualDocsRepo!.refreshStatuses(),
  );
}
