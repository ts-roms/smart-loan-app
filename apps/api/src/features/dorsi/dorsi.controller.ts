import type { FastifyReply, FastifyRequest } from "fastify";

import {
  boardApprovalSchema,
  checkSchema,
  configUpdateSchema,
  deactivateSchema,
  screenByNameSchema,
  tagSchema,
} from "./schemas";

/**
 * HTTP adapter for the DORSI compliance surface.
 *
 * Phase 2: stateless. Reads `req.dorsiServices!.dorsi` per call —
 * built per-request from the tenant-scoped Prisma client.
 */
export class DorsiController {
  list = (req: FastifyRequest) => req.dorsiServices!.dorsi.listActive();

  utilization = (req: FastifyRequest) => req.dorsiServices!.dorsi.utilization();

  showForCustomer = async (
    req: FastifyRequest<{ Params: { customerId: string } }>,
    reply: FastifyReply,
  ) => {
    const r = await req.dorsiServices!.dorsi.findForCustomer(
      req.params.customerId,
    );
    if (!r) return reply.code(404).send({ error: "NotFound" });
    return r;
  };

  tag = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = tagSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const created = await req.dorsiServices!.dorsi.tag(
        parsed.data,
        req.user.sub,
      );
      return reply.code(201).send(created);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: (err as Error).message });
    }
  };

  deactivate = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = deactivateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      return await req.dorsiServices!.dorsi.deactivate(
        req.params.id,
        parsed.data,
        req.user.sub,
      );
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: (err as Error).message });
    }
  };

  review = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    try {
      return await req.dorsiServices!.dorsi.markReviewed(
        req.params.id,
        req.user.sub,
      );
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: (err as Error).message });
    }
  };

  checkLoan = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = checkSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.dorsiServices!.dorsi.checkLoan(parsed.data);
  };

  /**
   * Auto-screen. The customer-onboarding flow calls this
   * with the new customer's full name; potential matches against the
   * active DORSI register are returned with a similarity score.
   */
  screenByName = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = screenByNameSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.dorsiServices!.dorsi.screenByName(parsed.data.name);
  };

  recordBoardApproval = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = boardApprovalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const approval = await req.dorsiServices!.dorsi.recordBoardApproval(
        parsed.data,
        req.user.sub,
      );
      return reply.code(201).send(approval);
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: (err as Error).message });
    }
  };

  findBoardApprovalForLoan = async (
    req: FastifyRequest<{ Params: { loanId: string } }>,
  ) => req.dorsiServices!.dorsi.findBoardApprovalForLoan(req.params.loanId);

  getConfig = async (req: FastifyRequest) => {
    const cfg = await req.dorsiServices!.dorsi.systemConfig();
    return {
      companyTotalEquity: Number(cfg.companyTotalEquity),
      updatedAt: cfg.updatedAt,
      updatedById: cfg.updatedById,
    };
  };

  updateConfig = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = configUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      return await req.dorsiServices!.dorsi.updateCompanyTotalEquity(
        parsed.data.companyTotalEquity,
        req.user.sub,
      );
    } catch (err) {
      return reply
        .code(400)
        .send({ error: "BadRequest", message: (err as Error).message });
    }
  };
}
