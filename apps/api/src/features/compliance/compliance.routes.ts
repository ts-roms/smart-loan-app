/**
 * Compliance routes — GDPR / PH Data Privacy Act §16 endpoints +
 * data-retention policy admin.
 *
 *   POST /compliance/customers/:id/export   admin.compliance
 *   POST /compliance/customers/:id/erase    admin.compliance
 *   GET  /compliance/retention-policy       admin.compliance
 *   PUT  /compliance/retention-policy       admin.compliance
 *   POST /compliance/retention-purge        admin.compliance  (manual)
 *
 * All gated on `admin.compliance` — a distinct permission so the
 * operator who answers DSARs doesn't need `admin.users` (and vice
 * versa).
 *
 * Phase 2: per-request service wiring via `req.complianceServices`.
 */

import { AuditLogRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { uploadStorage } from "../uploads/backend";

import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";
import {
  retentionPolicyResponseSchema,
  retentionPolicyUpdateSchema,
  retentionPurgeResponseSchema,
} from "./retention.schemas";
import { RetentionService } from "./retention.service";
import {
  customerIdParamSchema,
  documentPurgeRequestSchema,
  documentPurgeResponseSchema,
  eraseRequestSchema,
  eraseResponseSchema,
  exportResponseSchema,
} from "./schemas";

const TAGS = ["compliance"];

declare module "fastify" {
  interface FastifyRequest {
    complianceServices?: {
      compliance: ComplianceService;
      retention: RetentionService;
    };
  }
}

export async function complianceRoutes(app: FastifyInstance) {
  /*
   * onRequest, not preHandler — routes in this group carry request
   * schemas, and Fastify validates at preValidation, BEFORE preHandler.
   * With `authenticate` at preHandler an unauthenticated caller posting
   * a malformed erasure got a 400 describing the schema instead of a
   * 401. See decision-rules.routes.ts for the full account.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    const audit = new AuditLogRepository(prisma, req.user?.impersonatedBy);
    // Erasure deletes uploaded documents, so the service needs the
    // storage seam. `uploadStorage` is memoized process-wide, so this
    // is a map lookup per request rather than a new backend.
    req.complianceServices = {
      compliance: new ComplianceService(prisma, audit, uploadStorage(app.log)),
      retention: new RetentionService(prisma, audit),
    };
  });

  const ctrl = new ComplianceController();

  // ─── DSAR ─────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/customers/:id/export",
    {
      preHandler: app.requirePermission("admin.compliance"),
      /*
       * RESPONSE DOCUMENTED, REQUEST BODY DELIBERATELY NOT — and the
       * omission is load-bearing rather than an oversight.
       *
       * `exportRequestSchema` has one optional field, so the controller
       * parses `req.body ?? {}` and a POST with NO body at all is a
       * legal call. Attaching the body schema moves validation ahead of
       * the handler, and Fastify validates an absent body as
       * `undefined` against `type: "object"` — verified: a bodyless
       * POST answers 400 "body must be object" with the schema
       * attached, and 200 without it.
       *
       * That is the 401→400 trap wearing different clothes: documenting
       * a request would have narrowed what the endpoint accepts. The
       * `reason` field is described in schemas.ts for whoever wants to
       * send one; the wire contract stays as permissive as it has been.
       */
      schema: routeSchema({
        summary:
          "Subject-access export — everything the system holds on one " +
          "customer, flat by table, sent as a JSON file download. " +
          "Optional body: { reason } to tie the export to a ticket.",
        tags: TAGS,
        permission: "admin.compliance",
        params: customerIdParamSchema,
        response: exportResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.exportCustomer,
  );

  app.post<{ Params: { id: string } }>(
    "/customers/:id/erase",
    {
      preHandler: app.requirePermission("admin.compliance"),
      schema: routeSchema({
        summary:
          "Irreversibly redact a customer's PII in place AND delete their " +
          "uploaded KYC documents and application selfies from storage. " +
          "KYC header rows and financial records are retained; the " +
          "response reports the per-file outcome. 409 if already erased.",
        tags: TAGS,
        permission: "admin.compliance",
        params: customerIdParamSchema,
        body: eraseRequestSchema,
        response: eraseResponseSchema,
        errors: [400, 401, 403, 404, 409],
      }),
    },
    ctrl.eraseCustomer,
  );

  app.post<{ Params: { id: string } }>(
    "/customers/:id/documents-purge",
    {
      preHandler: app.requirePermission("admin.compliance"),
      schema: routeSchema({
        summary:
          "Delete the uploaded KYC documents and application selfies " +
          "behind a customer, keeping every header row. Defaults to a " +
          "dry run that reports the plan without deleting. Safe to re-run.",
        tags: TAGS,
        permission: "admin.compliance",
        params: customerIdParamSchema,
        body: documentPurgeRequestSchema,
        response: documentPurgeResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    ctrl.purgeCustomerDocuments,
  );

  // ─── retention ────────────────────────────────────────────────────
  app.get(
    "/retention-policy",
    {
      preHandler: app.requirePermission("admin.compliance"),
      schema: routeSchema({
        summary:
          "The data-retention windows driving the nightly purge, plus " +
          "whether the audit window sits below the AMLA §9 floor.",
        tags: TAGS,
        permission: "admin.compliance",
        response: retentionPolicyResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.getRetentionPolicy,
  );

  app.put(
    "/retention-policy",
    {
      preHandler: app.requirePermission("admin.compliance"),
      schema: routeSchema({
        summary:
          "Set the retention windows. 0 means never purge. An audit " +
          "window below the AMLA §9 floor of 1,825 days is REFUSED " +
          '(400, error: "BelowRegulatoryFloor"); the change is audited.',
        tags: TAGS,
        permission: "admin.compliance",
        body: retentionPolicyUpdateSchema,
        response: retentionPolicyResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.updateRetentionPolicy,
  );

  app.post(
    "/retention-purge",
    {
      preHandler: app.requirePermission("admin.compliance"),
      schema: routeSchema({
        summary:
          "Run the retention purge now rather than waiting for the " +
          "nightly tick. Answers the cutoffs used and the rows deleted.",
        tags: TAGS,
        permission: "admin.compliance",
        response: retentionPurgeResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.runRetentionPurge,
  );
}
