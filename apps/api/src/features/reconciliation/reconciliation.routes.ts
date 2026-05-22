/**
 * Bank reconciliation routes.
 *
 * All routes require `accounting.read` to view and `accounting.post_journal`
 * to mutate — reconciliation is essentially journal-adjacent work.
 *
 * Phase 2: per-request repo wiring against `req.tenantCtx.prisma`.
 */

import { AuditLogRepository, BankReconciliationRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { manualMatchSchema, statementSchema } from "./schemas";

declare module "fastify" {
  interface FastifyRequest {
    reconciliationCtx?: {
      repo: BankReconciliationRepository;
      audit: AuditLogRepository;
    };
  }
}

export async function reconciliationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  // Bank reconciliation is a PROFESSIONAL-tier feature.
  app.addHook("preHandler", app.requireFeature("accounting.reconciliation"));
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.reconciliationCtx = {
      repo: new BankReconciliationRepository(prisma),
      audit: new AuditLogRepository(prisma),
    };
  });

  app.get(
    "/statements",
    { preHandler: app.requirePermission("accounting.read") },
    async (req) => req.reconciliationCtx!.repo.list(),
  );

  app.get<{ Params: { id: string } }>(
    "/statements/:id",
    { preHandler: app.requirePermission("accounting.read") },
    async (req, reply) => {
      const s = await req.reconciliationCtx!.repo.findById(req.params.id);
      if (!s) return reply.code(404).send({ error: "NotFound" });
      return s;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/statements/:id/summary",
    { preHandler: app.requirePermission("accounting.read") },
    async (req) => req.reconciliationCtx!.repo.summary(req.params.id),
  );

  app.post(
    "/statements",
    { preHandler: app.requirePermission("accounting.post_journal") },
    async (req, reply) => {
      const { repo, audit } = req.reconciliationCtx!;
      const parsed = statementSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const statement = await repo.create(
        {
          label: parsed.data.label,
          bankAccount: parsed.data.bankAccount,
          periodStart: new Date(parsed.data.periodStart),
          periodEnd: new Date(parsed.data.periodEnd),
          openingBalance: parsed.data.openingBalance,
          closingBalance: parsed.data.closingBalance,
          importedById: req.user.sub,
        },
        parsed.data.lines.map((l) => ({
          txnDate: new Date(l.txnDate),
          description: l.description,
          amount: l.amount,
          reference: l.reference,
          runningBalance: l.runningBalance,
        })),
      );
      await audit.record({
        action: "BANK_STATEMENT_IMPORT",
        actorId: req.user.sub,
        targetType: "BankStatement",
        targetId: statement.id,
        payload: {
          lines: parsed.data.lines.length,
          label: parsed.data.label,
        },
      });
      return reply.code(201).send(statement);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/statements/:id/auto-match",
    { preHandler: app.requirePermission("accounting.post_journal") },
    async (req) => {
      const { repo, audit } = req.reconciliationCtx!;
      const result = await repo.autoMatch(req.params.id);
      await audit.record({
        action: "BANK_STATEMENT_AUTO_MATCH",
        actorId: req.user.sub,
        targetType: "BankStatement",
        targetId: req.params.id,
        payload: { matched: result.matchedLines, amount: result.matchedAmount },
      });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/lines/:id/match",
    { preHandler: app.requirePermission("accounting.post_journal") },
    async (req, reply) => {
      const parsed = manualMatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      return req.reconciliationCtx!.repo.manualMatch(req.params.id, {
        ...parsed.data,
        userId: req.user.sub,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/lines/:id/unmatch",
    { preHandler: app.requirePermission("accounting.post_journal") },
    async (req) => req.reconciliationCtx!.repo.unmatch(req.params.id),
  );

  /**
   * Scored match candidates for an unmatched line — used by the drawer
   * to surface suggestions before the human confirms one via /match.
   */
  app.get<{ Params: { id: string } }>(
    "/lines/:id/candidates",
    { preHandler: app.requirePermission("accounting.read") },
    async (req) => req.reconciliationCtx!.repo.candidatesFor(req.params.id, 10),
  );
}
