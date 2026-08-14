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

import { routeSchema } from "../../lib/openapi";

import {
  annualDocListResponseSchema,
  annualDocResponseSchema,
  createSchema,
  docIdParamSchema,
  expiringListResponseSchema,
  listExpiringQuerySchema,
  loanIdParamSchema,
  refreshStatusesResponseSchema,
} from "./schemas";

const TAGS = ["annual-docs"];

/*
 * Shared by BOTH plugins below.
 *
 * onRequest, not preHandler — routes in this feature carry request
 * schemas, and Fastify validates at preValidation, BEFORE preHandler.
 * With `authenticate` at preHandler an unauthenticated caller posting a
 * malformed document got a 400 describing the schema instead of a 401.
 * See decision-rules.routes.ts for the full account.
 *
 * This feature registers as two plugins against different prefixes, so
 * the hook order has to be established twice — hence the helper rather
 * than two copies that can drift apart.
 */
function attachAuth(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  // Annual / renewable docs are a PROFESSIONAL-tier feature. The gate
  // reads req.tenantCtx, so resolveTenant must run before it.
  app.addHook("preHandler", app.requireFeature("compliance.annual_docs"));
  app.addHook("preHandler", attachAnnualDocsRepo());
}

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
  attachAuth(app);

  app.get<{ Params: { loanId: string } }>(
    "/:loanId/annual-docs",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "Renewable documents tracked on one loan — insurance, OR/CR, " +
          "RPT — soonest expiry first.",
        tags: TAGS,
        permission: "loans.read",
        params: loanIdParamSchema,
        response: annualDocListResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async (req) => req.annualDocsRepo!.listForLoan(req.params.loanId),
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/annual-docs",
    {
      preHandler: app.requirePermission("loans.docs_renew"),
      schema: routeSchema({
        summary:
          "Record a renewable document against a loan. Status is derived " +
          "from expiresAt at insert. 400 if it is not after effectiveFrom.",
        tags: TAGS,
        permission: "loans.docs_renew",
        params: loanIdParamSchema,
        body: createSchema,
        response: annualDocResponseSchema,
        status: 201,
        errors: [400, 401, 402, 403],
      }),
    },
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
  attachAuth(app);

  app.get(
    "/expiring",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "Documents expiring within ?days (default 30) across all loans, " +
          "soonest first. INCLUDES already-expired rows.",
        tags: TAGS,
        permission: "loans.read",
        querystring: listExpiringQuerySchema,
        response: expiringListResponseSchema,
        errors: [400, 401, 402, 403],
      }),
    },
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
    {
      preHandler: app.requirePermission("loans.docs_renew"),
      schema: routeSchema({
        summary:
          "Delete a tracked document. Answers 204 with no body; 400 if " +
          "the row does not exist.",
        tags: TAGS,
        permission: "loans.docs_renew",
        params: docIdParamSchema,
        errors: [400, 401, 402, 403],
      }),
    },
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
    {
      preHandler: app.requirePermission("loans.docs_renew"),
      schema: routeSchema({
        summary:
          "Recompute every document's status now instead of waiting for " +
          "the nightly job. Answers the corpus counted by new status.",
        tags: TAGS,
        permission: "loans.docs_renew",
        response: refreshStatusesResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async (req) => req.annualDocsRepo!.refreshStatuses(),
  );
}
