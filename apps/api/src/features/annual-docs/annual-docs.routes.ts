/**
 * Annual / renewable document tracker — FRD §3.8.
 *
 *   GET  /loans/:loanId/annual-docs         loans.read
 *   POST /loans/:loanId/annual-docs         loans.docs_renew
 *   DELETE /annual-docs/:id                 loans.docs_renew
 *   GET  /annual-docs/expiring?days=30      loans.read
 *
 * Status is recomputed nightly by the scheduled job (see jobs.ts —
 * annual_doc_status_refresh) so dashboards can filter cheaply. The same
 * job also enqueues reminder notifications for docs entering the
 * EXPIRING_SOON window and at-expiry escalations.
 */

import { AnnualDocumentRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { createSchema, listExpiringQuerySchema } from "./schemas";

export async function annualDocsLoanRoutes(app: FastifyInstance) {
  const repo = new AnnualDocumentRepository(app.prisma);
  app.addHook("preHandler", app.authenticate);
  // Annual / renewable docs are a PROFESSIONAL-tier feature.
  app.addHook("preHandler", app.requireFeature("compliance.annual_docs"));

  app.get<{ Params: { loanId: string } }>(
    "/:loanId/annual-docs",
    { preHandler: app.requirePermission("loans.read") },
    async (req) => repo.listForLoan(req.params.loanId),
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
        const created = await repo.create({
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
  const repo = new AnnualDocumentRepository(app.prisma);
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.requireFeature("compliance.annual_docs"));

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
      return repo.listExpiring(parsed.data.days ?? 30);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("loans.docs_renew") },
    async (req, reply) => {
      try {
        await repo.remove(req.params.id);
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
    async () => repo.refreshStatuses(),
  );
}
