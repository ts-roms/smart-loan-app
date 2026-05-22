import type { FastifyReply, FastifyRequest } from "fastify";

import type { PrismaClient } from "@loan/db";

import type { DocumentsService, RenderResult } from "./documents.service";
import { sendPdf } from "./helpers";
import { signQuerySchema, wantsPersonnelSign } from "./schemas";

/**
 * HTTP adapter for document streaming. Officer routes accept
 * `?sign=1` to embed the caller's personnel signature; portal routes
 * resolve the customer id from the JWT and refuse to render anyone
 * else's documents.
 */
export class DocumentsController {
  constructor(
    private readonly service: DocumentsService,
    private readonly prisma: PrismaClient,
  ) {}

  // ─── officer ──────────────────────────────────────────────────────

  agreement = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.agreement({
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
    const result = await this.service.statement({
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
    const result = await this.service.receipt({
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
    const customerId = await this.resolveCustomer(req.user.sub);
    if (!customerId) return reply.code(404).send({ error: "NotFound" });
    const result = await this.service.portalAgreement({
      idOrNumber: req.params.id,
      customerId,
    });
    return this.send(result, reply);
  };

  portalStatement = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const customerId = await this.resolveCustomer(req.user.sub);
    if (!customerId) return reply.code(404).send({ error: "NotFound" });
    const result = await this.service.portalStatement({
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
    const customerId = await this.resolveCustomer(req.user.sub);
    if (!customerId) return reply.code(404).send({ error: "NotFound" });
    const result = await this.service.portalReceipt({
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

  /**
   * JWT subject → linked customer id, with a 404-safe failure when
   * the user isn't a CUSTOMER or isn't linked. We use 404 (not 403)
   * to match `portalRoutes` semantics: from the borrower's
   * perspective, anything they can't see "doesn't exist."
   */
  private async resolveCustomer(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
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
