/**
 * DORSI compliance API — FRD §3.10.
 *
 *   GET    /dorsi                       dorsi.read
 *   POST   /dorsi                       dorsi.tag
 *   POST   /dorsi/:id/deactivate        dorsi.tag
 *   POST   /dorsi/:id/review            dorsi.tag
 *   GET    /dorsi/customer/:customerId  dorsi.read
 *   GET    /dorsi/utilization           dorsi.read
 *   POST   /dorsi/check                 dorsi.read     (preview a proposed loan)
 *   POST   /dorsi/board-approval        dorsi.board_approve
 *   GET    /dorsi/config                dorsi.read
 *   PUT    /dorsi/config                admin.system_config
 *
 * Naming: spelled "DORSI" per stakeholder preference. No specific company
 * brand is hard-coded; the equity base lives in SystemConfig.
 */

import { AuditLogRepository, DorsiRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const tagSchema = z.object({
  customerId: z.string().uuid(),
  category: z.enum(["DIRECTOR", "OFFICER", "STOCKHOLDER", "RELATED_INTEREST"]),
  basis: z.string().min(3).max(500),
});

const deactivateSchema = z.object({
  reason: z.string().min(3).max(500),
});

const checkSchema = z.object({
  customerId: z.string().uuid(),
  principal: z.number().positive(),
});

const boardApprovalSchema = z.object({
  loanId: z.string().uuid(),
  meetingDate: z.string(),
  minutesRef: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
});

const configUpdateSchema = z.object({
  companyTotalEquity: z.number().nonnegative(),
});

export async function dorsiRoutes(app: FastifyInstance) {
  const repo = new DorsiRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  app.get("/", { preHandler: app.requirePermission("dorsi.read") }, async () =>
    repo.listActive(),
  );

  app.post(
    "/",
    { preHandler: app.requirePermission("dorsi.tag") },
    async (req, reply) => {
      const parsed = tagSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const created = await repo.tag({
          customerId: parsed.data.customerId,
          category: parsed.data.category,
          basis: parsed.data.basis,
          taggedById: req.user.sub,
        });
        await audit.record({
          action: "DORSI_TAG",
          actorId: req.user.sub,
          targetType: "DorsiRecord",
          targetId: created.id,
          payload: parsed.data,
        });
        return reply.code(201).send(created);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/deactivate",
    { preHandler: app.requirePermission("dorsi.tag") },
    async (req, reply) => {
      const parsed = deactivateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const updated = await repo.deactivate(req.params.id, {
          reason: parsed.data.reason,
          deactivatedById: req.user.sub,
        });
        await audit.record({
          action: "DORSI_DEACTIVATE",
          actorId: req.user.sub,
          targetType: "DorsiRecord",
          targetId: req.params.id,
          payload: parsed.data,
        });
        return updated;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/review",
    { preHandler: app.requirePermission("dorsi.tag") },
    async (req, reply) => {
      try {
        const updated = await repo.markReviewed(req.params.id, req.user.sub);
        await audit.record({
          action: "DORSI_REVIEW",
          actorId: req.user.sub,
          targetType: "DorsiRecord",
          targetId: req.params.id,
        });
        return updated;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { customerId: string } }>(
    "/customer/:customerId",
    { preHandler: app.requirePermission("dorsi.read") },
    async (req, reply) => {
      const r = await repo.findForCustomer(req.params.customerId);
      if (!r) return reply.code(404).send({ error: "NotFound" });
      return r;
    },
  );

  app.get(
    "/utilization",
    { preHandler: app.requirePermission("dorsi.read") },
    async () => repo.utilization(),
  );

  app.post(
    "/check",
    { preHandler: app.requirePermission("dorsi.read") },
    async (req, reply) => {
      const parsed = checkSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return repo.checkLoan(parsed.data);
    },
  );

  /**
   * Auto-screen by name — FRD §3.10.1. The customer-onboarding flow calls
   * this with the new customer's full name; potential matches against
   * the active DORSI register are returned with a similarity score. The
   * UI shows a confirmation prompt when matches are present.
   */
  app.post(
    "/screen-by-name",
    { preHandler: app.requirePermission("dorsi.read") },
    async (req, reply) => {
      const body = req.body as { name?: string } | undefined;
      if (!body?.name || body.name.trim().length < 2) {
        return reply.code(400).send({
          error: "ValidationError",
          message: "name required (>= 2 chars)",
        });
      }
      return repo.screenByName(body.name.trim());
    },
  );

  app.post(
    "/board-approval",
    { preHandler: app.requirePermission("dorsi.board_approve") },
    async (req, reply) => {
      const parsed = boardApprovalSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const approval = await repo.recordBoardApproval({
          loanId: parsed.data.loanId,
          meetingDate: new Date(parsed.data.meetingDate),
          minutesRef: parsed.data.minutesRef,
          note: parsed.data.note,
          approvedById: req.user.sub,
        });
        await audit.record({
          action: "DORSI_BOARD_APPROVE",
          actorId: req.user.sub,
          targetType: "DorsiBoardApproval",
          targetId: approval.id,
          payload: parsed.data,
        });
        return reply.code(201).send(approval);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { loanId: string } }>(
    "/board-approval/:loanId",
    { preHandler: app.requirePermission("dorsi.read") },
    async (req) => repo.findBoardApprovalForLoan(req.params.loanId),
  );

  // ── Config ──────────────────────────────────────────────────────────

  app.get(
    "/config",
    { preHandler: app.requirePermission("dorsi.read") },
    async () => {
      const cfg = await repo.systemConfig();
      return {
        companyTotalEquity: Number(cfg.companyTotalEquity),
        updatedAt: cfg.updatedAt,
        updatedById: cfg.updatedById,
      };
    },
  );

  app.put(
    "/config",
    { preHandler: app.requirePermission("admin.system_config") },
    async (req, reply) => {
      const parsed = configUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const result = await repo.updateCompanyTotalEquity(
          parsed.data.companyTotalEquity,
          req.user.sub,
        );
        await audit.record({
          action: "SYSTEM_CONFIG_UPDATE",
          actorId: req.user.sub,
          targetType: "SystemConfig",
          payload: { companyTotalEquity: parsed.data.companyTotalEquity },
        });
        return result;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );
}
