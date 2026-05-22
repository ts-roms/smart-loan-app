import { KycDuplicateError } from "@loan/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { decisionSchema, submitSchema } from "./schemas";

/**
 * HTTP adapter for the KYC surface. Three endpoints:
 *
 *   GET  /                          → all submissions for a customer
 *   POST /                          → submit a doc (409 on duplicate)
 *   POST /:id/decide                → officer verify / reject
 *   GET  /customers/:customerId/status → KYC rollup
 *
 * Phase 2: stateless. Each method reads `req.kycServices!.kyc` —
 * built per-request from the tenant-scoped Prisma client.
 *
 * The submit endpoint converts `KycDuplicateError` into a 409 Conflict
 * with the existing record attached so the UI can link to it instead
 * of asking the operator to guess what's already on file.
 */
export class KycController {
  list = async (
    req: FastifyRequest<{ Querystring: { customerId?: string } }>,
    reply: FastifyReply,
  ) => {
    if (!req.query.customerId) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: "customerId required" });
    }
    return req.kycServices!.kyc.listForCustomer(req.query.customerId);
  };

  submit = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const row = await req.kycServices!.kyc.submit({
        ...parsed.data,
        submittedById: req.user.sub,
      });
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof KycDuplicateError) {
        return reply.code(409).send({
          error: "Duplicate",
          message: err.message,
          existing: err.existing,
        });
      }
      throw err;
    }
  };

  decide = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.kycServices!.kyc.decide(req.params.id, {
      ...parsed.data,
      decidedById: req.user.sub,
    });
  };

  status = async (req: FastifyRequest<{ Params: { customerId: string } }>) =>
    req.kycServices!.kyc.statusForCustomer(req.params.customerId);
}
