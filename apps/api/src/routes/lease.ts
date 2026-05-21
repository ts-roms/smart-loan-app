/**
 * Lease-to-Own API — FRD §3.5.
 *
 *   GET    /lease                       lease.read
 *   GET    /lease/:loanId               lease.read
 *   POST   /lease/:loanId/buyout        lease.buyout
 *   POST   /lease/:loanId/pull-out      lease.pull_out
 *   POST   /lease/:loanId/return        lease.close
 *   POST   /lease/:loanId/extend        lease.close
 *
 * Agreements are created automatically by LoanRepository.disburse when
 * the product has `isLease=true`, so there's no POST /lease creation
 * endpoint — keeps the path of least surprise.
 */

import { AuditLogRepository, LeaseRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const buyoutSchema = z.object({
  amountPaid: z.number().positive(),
});

const pullOutSchema = z.object({
  reason: z.string().min(3).max(500),
});

const closeSchema = z.object({
  reason: z.string().min(3).max(500),
});

const listQuerySchema = z.object({
  status: z
    .enum(["ACTIVE", "PULLED_OUT", "BUYOUT_COMPLETED", "RETURNED", "EXTENDED"])
    .optional(),
});

export async function leaseRoutes(app: FastifyInstance) {
  const repo = new LeaseRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    { preHandler: app.requirePermission("lease.read") },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return repo.list(parsed.data);
    },
  );

  app.get<{ Params: { loanId: string } }>(
    "/:loanId",
    { preHandler: app.requirePermission("lease.read") },
    async (req, reply) => {
      const a = await repo.findForLoan(req.params.loanId);
      if (!a) return reply.code(404).send({ error: "NotFound" });
      return a;
    },
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/buyout",
    { preHandler: app.requirePermission("lease.buyout") },
    async (req, reply) => {
      const parsed = buyoutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const result = await repo.completeBuyout({
          loanId: req.params.loanId,
          amountPaid: parsed.data.amountPaid,
          buyoutById: req.user.sub,
        });
        await audit.record({
          action: "LEASE_BUYOUT",
          actorId: req.user.sub,
          targetType: "LeaseAgreement",
          targetId: result.agreement.id,
          payload: {
            loanId: req.params.loanId,
            amountPaid: parsed.data.amountPaid,
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

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/pull-out",
    { preHandler: app.requirePermission("lease.pull_out") },
    async (req, reply) => {
      const parsed = pullOutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const updated = await repo.pullOut({
          loanId: req.params.loanId,
          reason: parsed.data.reason,
          pulledOutById: req.user.sub,
        });
        await audit.record({
          action: "LEASE_PULL_OUT",
          actorId: req.user.sub,
          targetType: "LeaseAgreement",
          targetId: updated.id,
          payload: { loanId: req.params.loanId, reason: parsed.data.reason },
        });
        return updated;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/return",
    { preHandler: app.requirePermission("lease.close") },
    async (req, reply) => {
      const parsed = closeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const updated = await repo.closeAsReturned(
          req.params.loanId,
          parsed.data.reason,
        );
        await audit.record({
          action: "LEASE_RETURNED",
          actorId: req.user.sub,
          targetType: "LeaseAgreement",
          targetId: updated.id,
          payload: { loanId: req.params.loanId, reason: parsed.data.reason },
        });
        return updated;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { loanId: string } }>(
    "/:loanId/extend",
    { preHandler: app.requirePermission("lease.close") },
    async (req, reply) => {
      const parsed = closeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const updated = await repo.closeAsExtended(
          req.params.loanId,
          parsed.data.reason,
        );
        await audit.record({
          action: "LEASE_EXTENDED",
          actorId: req.user.sub,
          targetType: "LeaseAgreement",
          targetId: updated.id,
          payload: { loanId: req.params.loanId, reason: parsed.data.reason },
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
