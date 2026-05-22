import type { FastifyReply, FastifyRequest } from "fastify";

import type { DorsiService } from "./dorsi.service.js";
import {
  boardApprovalSchema,
  checkSchema,
  configUpdateSchema,
  deactivateSchema,
  screenByNameSchema,
  tagSchema,
} from "./schemas.js";

/**
 * HTTP adapter for the DORSI compliance surface. Each method maps a
 * single route's HTTP contract onto a service call:
 *
 *   - 4xx mapping on validation failures + service errors
 *   - 404 for missing-customer / missing-record lookups
 *   - Pull `req.user.sub` for the audit actorId argument
 */
export class DorsiController {
  constructor(private readonly service: DorsiService) {}

  list = () => this.service.listActive();

  utilization = () => this.service.utilization();

  showForCustomer = async (
    req: FastifyRequest<{ Params: { customerId: string } }>,
    reply: FastifyReply,
  ) => {
    const r = await this.service.findForCustomer(req.params.customerId);
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
      const created = await this.service.tag(parsed.data, req.user.sub);
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
      return await this.service.deactivate(
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
      return await this.service.markReviewed(req.params.id, req.user.sub);
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
    return this.service.checkLoan(parsed.data);
  };

  /**
   * FRD §3.10.1 auto-screen. The customer-onboarding flow calls this
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
    return this.service.screenByName(parsed.data.name);
  };

  recordBoardApproval = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = boardApprovalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const approval = await this.service.recordBoardApproval(
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
  ) => this.service.findBoardApprovalForLoan(req.params.loanId);

  getConfig = async () => {
    const cfg = await this.service.systemConfig();
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
      return await this.service.updateCompanyTotalEquity(
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
