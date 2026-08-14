import type { FastifyInstance } from "fastify";

import { routeSchema } from "../../lib/openapi";
import type { KycController } from "./kyc.controller";
import {
  decisionSchema,
  kycCustomerIdParamSchema,
  kycIdParamSchema,
  kycListQuerySchema,
  kycListResponseSchema,
  kycPendingQuerySchema,
  kycPendingResponseSchema,
  kycStatusResponseSchema,
  kycSubmissionResponseSchema,
  submitSchema,
} from "./schemas";

const TAGS = ["kyc"];

/**
 * HTTP wiring for the KYC surface. All endpoints sit under /kyc; the
 * customer-scoped status endpoint uses /kyc/customers/:customerId/status
 * so it doesn't collide with /kyc/:id.
 *
 * Authorization mirrors the three KYC permissions:
 *
 *   GET  /                              kyc.read
 *   GET  /customers/:customerId/status  kyc.read
 *   POST /                              kyc.submit
 *   POST /:id/decide                    kyc.decide
 *
 * These are the officer-side routes — they take a customerId from the
 * request, so a borrower reaching them could read (or file) documents
 * against anyone. The borrower's own submission path is
 * `/api/v1/portal/kyc`, which resolves the customer from the JWT sub.
 *
 * ## Auth posture: `onRequest`, and that is load-bearing
 *
 * `kyc/index.ts` moved `app.authenticate` from `preHandler` to
 * `onRequest` when these schemas were attached. Fastify validates the
 * request BEFORE `preHandler` runs, so with auth one stage later an
 * anonymous caller sending a malformed body would have been told what
 * was wrong with their schema (400) instead of that they were not
 * logged in (401) — leaking the request shape to someone with no
 * credentials, and burying the real problem. `onRequest` runs ahead of
 * validation, so 401 still wins.
 */
export function registerKycHttp(
  app: FastifyInstance,
  controller: KycController,
): void {
  app.get<{ Querystring: { customerId?: string } }>(
    "/",
    {
      preHandler: app.requirePermission("kyc.read"),
      schema: routeSchema({
        summary:
          "Every KYC submission for one customer. `customerId` is " +
          "required despite being optional in the schema — the handler " +
          "answers 400 without it, and narrowing it here would change " +
          "the body callers already get.",
        tags: TAGS,
        permission: "kyc.read",
        querystring: kycListQuerySchema,
        response: kycListResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    controller.list,
  );
  /*
   * The review queue. Declared before "/:id/decide" and separate from
   * "/" because "/" demands a customerId — which is precisely why the
   * console used to fetch every customer and then ask about each one
   * individually.
   */
  app.get<{ Querystring: { page?: string; pageSize?: string } }>(
    "/pending",
    {
      preHandler: app.requirePermission("kyc.read"),
      schema: routeSchema({
        summary:
          "The review queue — submissions awaiting a decision, oldest " +
          "first, with the customer folded in so the list renders " +
          "without a fetch per row.",
        tags: TAGS,
        permission: "kyc.read",
        querystring: kycPendingQuerySchema,
        response: kycPendingResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    controller.listPending,
  );
  app.post(
    "/",
    {
      preHandler: app.requirePermission("kyc.submit"),
      schema: routeSchema({
        summary:
          "File a document for verification. 409 when this customer " +
          "already has a PENDING or VERIFIED document of the same type " +
          "— the conflicting record travels on the error body as " +
          "`existing` so the UI can link to it.",
        tags: TAGS,
        permission: "kyc.submit",
        body: submitSchema,
        response: kycSubmissionResponseSchema,
        status: 201,
        errors: [400, 401, 403, 409],
      }),
    },
    controller.submit,
  );
  app.post<{ Params: { id: string } }>(
    "/:id/decide",
    {
      preHandler: app.requirePermission("kyc.decide"),
      schema: routeSchema({
        summary:
          "Verify or reject a submission. Also recomputes the " +
          "customer's KYC rollup — VERIFIED only once every required " +
          "document is.",
        tags: TAGS,
        permission: "kyc.decide",
        params: kycIdParamSchema,
        body: decisionSchema,
        response: kycSubmissionResponseSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    controller.decide,
  );
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/status",
    {
      preHandler: app.requirePermission("kyc.read"),
      schema: routeSchema({
        summary:
          "KYC rollup for one customer — complete, plus which required " +
          "documents are still missing or were rejected. Computed from " +
          "the submissions, not stored.",
        tags: TAGS,
        permission: "kyc.read",
        params: kycCustomerIdParamSchema,
        response: kycStatusResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    controller.status,
  );
}
