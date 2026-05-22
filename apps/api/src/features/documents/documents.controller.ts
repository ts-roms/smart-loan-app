import type { FastifyReply, FastifyRequest } from "fastify";

import type { RenderResult } from "./documents.service";
import { sendPdf } from "./helpers";
import { signQuerySchema, wantsPersonnelSign } from "./schemas";

/**
 * HTTP adapter for document streaming. Phase 2: stateless. Reads
 * `req.documentsServices.documents` per call. Customer resolution
 * for the portal mirror uses `req.tenantCtx.prisma` directly.
 */
export class DocumentsController {
  // ─── officer ──────────────────────────────────────────────────────

  agreement = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.documentsServices!.documents.agreement({
      idOrNumber: req.params.id,
      actorId: req.user.sub,
      wantsSign: wantsPersonnelSign(this.parseSign(req.query)),
    });
    return this.send(result, reply);
  };

  statement = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.documentsServices!.documents.statement({
      idOrNumber: req.params.id,
      actorId: req.user.sub,
      wantsSign: wantsPersonnelSign(this.parseSign(req.query)),
    });
    return this.send(result, reply);
  };

  receipt = async (
    req: FastifyRequest<{
      Params: { loanId: string; paymentId: string };
    }>,
    reply: FastifyReply,
  ) => {
    const result = await req.documentsServices!.documents.receipt({
      loanId: req.params.loanId,
      paymentId: req.params.paymentId,
      actorId: req.user.sub,
      wantsSign: wantsPersonnelSign(this.parseSign(req.query)),
    });
    return this.send(result, reply);
  };

  // ─── portal mirror ────────────────────────────────────────────────

  portalAgreement = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const customerId = await this.resolveCustomer(req);
    if (!customerId) return reply.code(404).send({ error: "NotFound" });
    const result = await req.documentsServices!.documents.portalAgreement({
      idOrNumber: req.params.id,
      customerId,
    });
    return this.send(result, reply);
  };

  portalStatement = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const customerId = await this.resolveCustomer(req);
    if (!customerId) return reply.code(404).send({ error: "NotFound" });
    const result = await req.documentsServices!.documents.portalStatement({
      idOrNumber: req.params.id,
      customerId,
    });
    return this.send(result, reply);
  };

  portalReceipt = async (
    req: FastifyRequest<{
      Params: { loanId: string; paymentId: string };
    }>,
    reply: FastifyReply,
  ) => {
    const customerId = await this.resolveCustomer(req);
    if (!customerId) return reply.code(404).send({ error: "NotFound" });
    const result = await req.documentsServices!.documents.portalReceipt({
      loanId: req.params.loanId,
      paymentId: req.params.paymentId,
      customerId,
    });
    return this.send(result, reply);
  };

  // ─── internals ────────────────────────────────────────────────────

  private parseSign(raw: unknown) {
    const parsed = signQuerySchema.safeParse(raw);
    return parsed.success ? parsed.data : { sign: undefined };
  }

  private async resolveCustomer(req: FastifyRequest): Promise<string | null> {
    const u = await req.tenantCtx.prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { role: true, customerId: true },
    });
    if (!u || u.role !== "CUSTOMER" || !u.customerId) return null;
    return u.customerId;
  }

  private send(result: RenderResult, reply: FastifyReply) {
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return sendPdf(reply, result.bundle.buf, result.bundle.filename);
  }
}
