/**
 * Repossession API — FRD §3.7.
 *
 * Each state transition is its own endpoint, gated by a distinct
 * permission so the chain (BM → Credit Head → Legal) can be routed to
 * different roles via RBAC.
 *
 *   POST   /repossession              repossession.identify
 *   GET    /repossession              loans.read
 *   GET    /repossession/:id          loans.read
 *   POST   /repossession/:id/bm-approve         repossession.bm_approve
 *   POST   /repossession/:id/credit-approve     repossession.credit_approve
 *   POST   /repossession/:id/legal-approve      repossession.legal_approve
 *   POST   /repossession/:id/assign-agent       repossession.assign_agent
 *   POST   /repossession/:id/recover            repossession.recover
 *   POST   /repossession/:id/auction            repossession.auction
 *   POST   /repossession/:id/cancel             repossession.identify
 */

import {
  AuditLogRepository,
  LoanRepository,
  RepossessionRepository,
} from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const openSchema = z.object({
  loanId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});

const approvalSchema = z.object({
  note: z.string().max(500).optional(),
});

const assignSchema = z.object({
  agentName: z.string().min(1).max(120),
  agentContact: z.string().min(1).max(120),
});

const recoverSchema = z.object({
  vehicleCondition: z.string().min(1).max(500),
  vehicleMileage: z.number().int().min(0).optional(),
  vehiclePhotos: z.array(z.string().max(500)).max(20).optional(),
  storageLocation: z.string().min(1).max(200),
  outstandingAtRecovery: z.number().positive(),
});

const auctionSchema = z.object({
  auctionMethod: z.string().min(1).max(40),
  auctionProceeds: z.number().nonnegative(),
});

const cancelSchema = z.object({
  reason: z.string().min(3).max(500),
});

const listQuerySchema = z.object({
  status: z.string().optional(),
  loanId: z.string().uuid().optional(),
});

export async function repossessionRoutes(app: FastifyInstance) {
  const repo = new RepossessionRepository(app.prisma);
  const loans = new LoanRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return repo.list({
        status: parsed.data.status as never,
        loanId: parsed.data.loanId,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const c = await repo.findById(req.params.id);
      if (!c) return reply.code(404).send({ error: "NotFound" });
      return c;
    },
  );

  app.post(
    "/",
    { preHandler: app.requirePermission("repossession.identify") },
    async (req, reply) => {
      const parsed = openSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const created = await repo.openCase({
          loanId: parsed.data.loanId,
          reason: parsed.data.reason,
          identifiedById: req.user.sub,
        });
        await audit.record({
          action: "REPOSSESSION_IDENTIFY",
          actorId: req.user.sub,
          targetType: "RepossessionCase",
          targetId: created.id,
          payload: { loanId: parsed.data.loanId, reason: parsed.data.reason },
        });
        return reply.code(201).send(created);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  // Approval chain — each step is a single tick on the case.
  for (const [route, perm, action, method] of [
    [
      "/:id/bm-approve",
      "repossession.bm_approve",
      "REPOSSESSION_BM_APPROVE",
      "bmApprove" as const,
    ],
    [
      "/:id/credit-approve",
      "repossession.credit_approve",
      "REPOSSESSION_CREDIT_APPROVE",
      "creditHeadApprove" as const,
    ],
    [
      "/:id/legal-approve",
      "repossession.legal_approve",
      "REPOSSESSION_LEGAL_APPROVE",
      "legalApprove" as const,
    ],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      route,
      { preHandler: app.requirePermission(perm) },
      async (req, reply) => {
        const parsed = approvalSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "ValidationError", issues: parsed.error.issues });
        }
        try {
          const updated = await repo[method]({
            caseId: req.params.id,
            approvedById: req.user.sub,
            note: parsed.data.note,
          });
          await audit.record({
            action,
            actorId: req.user.sub,
            targetType: "RepossessionCase",
            targetId: req.params.id,
            payload: { note: parsed.data.note },
          });
          return updated;
        } catch (err) {
          return reply
            .code(400)
            .send({ error: "BadRequest", message: (err as Error).message });
        }
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    "/:id/assign-agent",
    { preHandler: app.requirePermission("repossession.assign_agent") },
    async (req, reply) => {
      const parsed = assignSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const updated = await repo.assignAgent({
          caseId: req.params.id,
          agentName: parsed.data.agentName,
          agentContact: parsed.data.agentContact,
          assignedById: req.user.sub,
        });
        await audit.record({
          action: "REPOSSESSION_ASSIGN_AGENT",
          actorId: req.user.sub,
          targetType: "RepossessionCase",
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
    "/:id/recover",
    { preHandler: app.requirePermission("repossession.recover") },
    async (req, reply) => {
      const parsed = recoverSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const updated = await repo.recover({
          caseId: req.params.id,
          vehicleCondition: parsed.data.vehicleCondition,
          vehicleMileage: parsed.data.vehicleMileage,
          vehiclePhotos: parsed.data.vehiclePhotos,
          storageLocation: parsed.data.storageLocation,
          outstandingAtRecovery: parsed.data.outstandingAtRecovery,
          recoveredById: req.user.sub,
        });
        await audit.record({
          action: "REPOSSESSION_RECOVER",
          actorId: req.user.sub,
          targetType: "RepossessionCase",
          targetId: req.params.id,
          payload: {
            outstanding: parsed.data.outstandingAtRecovery,
            storage: parsed.data.storageLocation,
          },
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
    "/:id/auction",
    { preHandler: app.requirePermission("repossession.auction") },
    async (req, reply) => {
      const parsed = auctionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const result = await repo.auction({
          caseId: req.params.id,
          auctionMethod: parsed.data.auctionMethod,
          auctionProceeds: parsed.data.auctionProceeds,
          auctionedById: req.user.sub,
        });
        await audit.record({
          action: "REPOSSESSION_AUCTION",
          actorId: req.user.sub,
          targetType: "RepossessionCase",
          targetId: req.params.id,
          payload: {
            method: parsed.data.auctionMethod,
            proceeds: parsed.data.auctionProceeds,
            deficiency: result.deficiency,
            surplus: result.surplus,
            journalEntryId: result.journalEntryId,
          },
        });
        return reply.code(201).send(result);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/cancel",
    { preHandler: app.requirePermission("repossession.identify") },
    async (req, reply) => {
      const parsed = cancelSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const updated = await repo.cancel({
          caseId: req.params.id,
          reason: parsed.data.reason,
          cancelledById: req.user.sub,
        });
        await audit.record({
          action: "REPOSSESSION_CANCEL",
          actorId: req.user.sub,
          targetType: "RepossessionCase",
          targetId: req.params.id,
          payload: { reason: parsed.data.reason },
        });
        return updated;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  /**
   * Helper for the UI — returns the current outstanding principal on the
   * loan so the recover form can default-fill outstandingAtRecovery.
   */
  app.get<{ Params: { id: string } }>(
    "/:id/outstanding",
    { preHandler: app.requirePermission("loans.read") },
    async (req, reply) => {
      const c = await repo.findById(req.params.id);
      if (!c) return reply.code(404).send({ error: "NotFound" });
      const schedule = await app.prisma.loanSchedule.findMany({
        where: { loanId: c.loanId, paidInFullAt: null },
      });
      const outstanding = schedule.reduce(
        (s, x) => s + (Number(x.totalDue) - Number(x.principalPaid)),
        0,
      );
      const penalties = await loans.accruedPenaltiesFor(c.loanId);
      return {
        outstandingPrincipal: Math.round(outstanding * 100) / 100,
        outstandingPenalties: penalties.outstanding,
        totalOutstanding:
          Math.round((outstanding + penalties.outstanding) * 100) / 100,
      };
    },
  );
}
