import { KycDuplicateError, KycRepository } from "@loan/db";
import { validateKyc } from "@loan/kyc";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

// Mirror of Prisma's KycDocumentType enum. Kept in sync by hand because
// zod can't introspect Prisma types — the full list lives in
// libs/db/prisma/schema.prisma. If a value is added there, add it here.
const submitSchema = z.object({
  customerId: z.string().uuid(),
  documentType: z.enum([
    "ID_FRONT",
    "ID_BACK",
    "PROOF_OF_INCOME",
    "PROOF_OF_ADDRESS",
    "SELFIE",
    "VEHICLE_OR",
    "VEHICLE_CR",
    "PROPERTY_TITLE",
    "TAX_DECLARATION",
  ]),
  documentUrl: z.string().min(1),
  notes: z.string().max(500).optional(),
});

const decisionSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().max(500).optional(),
});

export async function kycRoutes(app: FastifyInstance) {
  const kyc = new KycRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  /** All KYC submissions for a customer. */
  app.get<{ Querystring: { customerId?: string } }>("/", async (req, reply) => {
    if (!req.query.customerId) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: "customerId required" });
    }
    return kyc.listForCustomer(req.query.customerId);
  });

  /**
   * Submit a document for verification.
   *
   * Returns 409 Conflict (instead of 201) when the customer already has
   * a PENDING or VERIFIED submission of the same documentType — the
   * existing record is included in the response so the UI can link to
   * it. REJECTED docs may still be resubmitted (the normal retry path
   * after the officer requested a re-upload).
   */
  app.post("/", async (req, reply) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const row = await kyc.submit({
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
  });

  /** Officer's decide call — verify or reject a submitted doc. */
  app.post<{ Params: { id: string } }>("/:id/decide", async (req, reply) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return kyc.decide(req.params.id, {
      status: parsed.data.status,
      reason: parsed.data.reason,
      decidedById: req.user.sub,
    });
  });

  /** Read-only summary: which doc types are still pending? */
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/status",
    async (req) => {
      const docs = await kyc.listForCustomer(req.params.customerId);
      return validateKyc(docs);
    },
  );
}
