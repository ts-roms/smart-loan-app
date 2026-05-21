/**
 * Demand Letter API — FRD §3.6.
 *
 *   GET    /demand-letters/candidates?stage=FIRST  collections.demand_letter
 *   GET    /demand-letters?stage=&status=          collections.read
 *   GET    /demand-letters/:id                     collections.read
 *   POST   /demand-letters/batch                   collections.demand_letter
 *   POST   /demand-letters/:id/dispatch            collections.demand_letter
 *   POST   /demand-letters/:id/close               collections.demand_letter
 *
 * Batch flow:
 *   1. Officer opens /collections/demand-letters in the UI.
 *   2. Picks stage filter (FIRST=60d / FINAL=90d / attorney variants).
 *   3. Clicks Display -> GET candidates.
 *   4. Ticks rows to generate for, clicks Generate -> POST /batch.
 *   5. Reviews each draft, then Dispatch -> notification fires.
 *
 * `loans.accruedPenaltiesFor` is injected into the repo's draftBatch
 * call so we get an accurate penalty snapshot per loan at draft time
 * (the candidate list uses 0 for cost reasons; this fills it in).
 */

import {
  AuditLogRepository,
  DemandLetterRepository,
  LoanRepository,
  type NotificationRepository,
} from "@loan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const stageEnum = z.enum([
  "FIRST",
  "FINAL",
  "ATTORNEY_FIRST",
  "ATTORNEY_FINAL",
]);
const statusEnum = z.enum([
  "DRAFTED",
  "APPROVED",
  "DISPATCHED",
  "RESPONDED",
  "WAIVED",
]);

const candidatesQuerySchema = z.object({
  stage: stageEnum,
});

const listQuerySchema = z.object({
  stage: stageEnum.optional(),
  status: statusEnum.optional(),
  loanId: z.string().uuid().optional(),
  take: z.coerce.number().int().min(1).max(500).optional(),
});

const batchSchema = z.object({
  loanIds: z.array(z.string().uuid()).min(1).max(200),
  stage: stageEnum,
  paymentDeadlineDays: z.number().int().min(1).max(60).optional(),
});

const approveSchema = z.object({
  note: z.string().max(500).optional(),
});

const dispatchSchema = z.object({
  channel: z.string().min(1).max(40),
  ref: z.string().max(120).optional(),
});

const closeSchema = z.object({
  status: z.enum(["RESPONDED", "WAIVED"]),
  reason: z.string().min(3).max(500),
});

const STAGE_LABEL: Record<string, string> = {
  FIRST: "First Demand Letter",
  FINAL: "Final Demand Letter",
  ATTORNEY_FIRST: "Attorney Demand Letter",
  ATTORNEY_FINAL: "Final Attorney Demand Letter",
};

export async function demandLetterRoutes(app: FastifyInstance) {
  const repo = new DemandLetterRepository(app.prisma);
  const loans = new LoanRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  /** Loans eligible for a demand letter at this stage. */
  app.get(
    "/candidates",
    { preHandler: app.requirePermission("collections.demand_letter") },
    async (req, reply) => {
      const parsed = candidatesQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return repo.identifyCandidates(parsed.data.stage);
    },
  );

  /** All letters, optionally filtered by stage/status/loan. */
  app.get(
    "/",
    { preHandler: app.requirePermission("collections.read") },
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

  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: app.requirePermission("collections.read") },
    async (req, reply) => {
      const letter = await repo.findById(req.params.id);
      if (!letter) return reply.code(404).send({ error: "NotFound" });
      return letter;
    },
  );

  /** Batch-draft letters for selected loans. */
  app.post(
    "/batch",
    { preHandler: app.requirePermission("collections.demand_letter") },
    async (req, reply) => {
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const created = await repo.draftBatch(
          {
            loanIds: parsed.data.loanIds,
            stage: parsed.data.stage,
            paymentDeadlineDays: parsed.data.paymentDeadlineDays,
            draftedById: req.user.sub,
          },
          async (loanId) => {
            const t = await loans.accruedPenaltiesFor(loanId);
            return t.outstanding;
          },
        );
        await audit.record({
          action: "DEMAND_LETTER_BATCH_DRAFT",
          actorId: req.user.sub,
          targetType: "DemandLetter",
          payload: {
            stage: parsed.data.stage,
            requested: parsed.data.loanIds.length,
            created: created.length,
          },
        });
        return reply
          .code(201)
          .send({ created: created.length, letters: created });
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );

  /**
   * Approve a drafted letter — FRD §3.6.5 escalation matrix. Permission
   * picked dynamically based on letter stage:
   *   - FIRST / FINAL          → collections.dl_approve_company
   *   - ATTORNEY_FIRST / FINAL → collections.dl_approve_legal
   *
   * The drafter can never approve their own letter — a separate person
   * has to sign off (segregation-of-duties enforcement).
   */
  app.post<{ Params: { id: string } }>(
    "/:id/approve",
    // Use requirePermission with both keys so the auth plugin loads the
    // user's perm set onto req.permissions; we narrow by stage below.
    {
      preHandler: app.requirePermission(
        "collections.dl_approve_company",
        "collections.dl_approve_legal",
      ),
    },
    async (req, reply) => {
      const parsed = approveSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const letter = await repo.findById(req.params.id);
      if (!letter) return reply.code(404).send({ error: "NotFound" });

      // Stage-based perm narrowing — FRD §3.6.5 escalation matrix.
      const requiredPerm =
        letter.stage === "ATTORNEY_FIRST" || letter.stage === "ATTORNEY_FINAL"
          ? "collections.dl_approve_legal"
          : "collections.dl_approve_company";
      if (!req.permissions?.has(requiredPerm)) {
        return reply.code(403).send({
          error: "Forbidden",
          message: `Stage ${letter.stage} requires permission ${requiredPerm} (FRD §3.6.5).`,
        });
      }

      // Segregation of duties — drafter cannot self-approve.
      if (letter.draftedById === req.user.sub) {
        return reply.code(403).send({
          error: "Forbidden",
          message:
            "Drafter cannot self-approve (FRD §3.6.5 segregation of duties).",
        });
      }

      try {
        const updated = await repo.approve(req.params.id, {
          approvedById: req.user.sub,
          note: parsed.data.note,
        });
        await audit.record({
          action: "DEMAND_LETTER_APPROVE",
          actorId: req.user.sub,
          targetType: "DemandLetter",
          targetId: updated.id,
          payload: { stage: letter.stage, note: parsed.data.note },
        });
        return updated;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: (err as Error).message });
      }
    },
  );

  /** APPROVED -> DISPATCHED. Sends notification to borrower (best-effort). */
  app.post<{ Params: { id: string } }>(
    "/:id/dispatch",
    { preHandler: app.requirePermission("collections.dl_dispatch") },
    async (req, reply) => {
      const parsed = dispatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const letter = await repo.dispatch(req.params.id, {
          channel: parsed.data.channel,
          ref: parsed.data.ref,
          dispatchedById: req.user.sub,
        });

        // Best-effort customer notification — failures don't roll back the
        // state transition (the letter is already dispatched in the legal
        // sense; the notification is operational only).
        try {
          const fullLetter = await app.prisma.demandLetter.findUnique({
            where: { id: letter.id },
            include: { loan: { include: { customer: true } } },
          });
          const c = fullLetter?.loan.customer;
          if (c && (c.email || c.phone)) {
            const data = {
              customerName: `${c.firstName} ${c.lastName}`,
              loanNumber: fullLetter!.loan.number,
              stageLabel: STAGE_LABEL[letter.stage] ?? letter.stage,
              totalOwed: Number(letter.totalOwed).toFixed(2),
              paymentDeadline: letter.paymentDeadline
                .toISOString()
                .slice(0, 10),
            };
            const channels: Array<{
              channel: "EMAIL" | "SMS";
              recipient: string;
            }> = [];
            if (c.email)
              channels.push({ channel: "EMAIL", recipient: c.email });
            if (c.phone) channels.push({ channel: "SMS", recipient: c.phone });
            const notifs = (
              app as unknown as { notifications: NotificationRepository }
            ).notifications;
            for (const ch of channels) {
              await notifs.dispatch({
                event: "DEMAND_LETTER_DISPATCHED",
                channel: ch.channel,
                recipient: ch.recipient,
                data,
                refType: "DemandLetter",
                refId: letter.id,
                customerId: c.id,
              });
            }
          }
        } catch (err) {
          app.log.warn({ err }, "Demand-letter notification dispatch failed");
        }

        await audit.record({
          action: "DEMAND_LETTER_DISPATCH",
          actorId: req.user.sub,
          targetType: "DemandLetter",
          targetId: letter.id,
          payload: {
            stage: letter.stage,
            channel: parsed.data.channel,
            ref: parsed.data.ref,
            loanId: letter.loanId,
          },
        });
        return letter;
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );

  /** Close as RESPONDED (paid) or WAIVED (skip). */
  app.post<{ Params: { id: string } }>(
    "/:id/close",
    { preHandler: app.requirePermission("collections.demand_letter") },
    async (req, reply) => {
      const parsed = closeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      try {
        const letter = await repo.close(req.params.id, {
          status: parsed.data.status,
          reason: parsed.data.reason,
          closedById: req.user.sub,
        });
        await audit.record({
          action:
            parsed.data.status === "WAIVED"
              ? "DEMAND_LETTER_WAIVE"
              : "DEMAND_LETTER_RESPONDED",
          actorId: req.user.sub,
          targetType: "DemandLetter",
          targetId: letter.id,
          payload: { reason: parsed.data.reason },
        });
        return letter;
      } catch (err) {
        return reply.code(400).send({
          error: "BadRequest",
          message: (err as Error).message,
        });
      }
    },
  );
}
