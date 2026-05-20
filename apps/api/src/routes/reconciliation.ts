/**
 * Bank reconciliation routes.
 *
 *   POST /reconciliation/statements         — create a new statement + lines
 *   GET  /reconciliation/statements         — list statements
 *   GET  /reconciliation/statements/:id     — statement + lines
 *   POST /reconciliation/statements/:id/auto-match — run the auto-matcher
 *   GET  /reconciliation/statements/:id/summary    — counts + amounts
 *   POST /reconciliation/lines/:id/match    — manual match a single line
 *   POST /reconciliation/lines/:id/unmatch  — undo a match
 *
 * All routes require `accounting.read` to view and `accounting.post_journal`
 * to mutate — reconciliation is essentially journal-adjacent work.
 */

import { AuditLogRepository, BankReconciliationRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const lineInputSchema = z.object({
  txnDate: z.string(),
  description: z.string().min(1).max(500),
  amount: z.number(),
  reference: z.string().max(120).optional(),
  runningBalance: z.number().optional(),
});

const statementSchema = z.object({
  label: z.string().min(1).max(120),
  bankAccount: z.string().min(1).max(120),
  periodStart: z.string(),
  periodEnd: z.string(),
  openingBalance: z.number(),
  closingBalance: z.number(),
  lines: z.array(lineInputSchema).min(1).max(5000),
});

const manualMatchSchema = z.object({
  type: z.string().min(1).max(40),
  refId: z.string().max(60).optional(),
  note: z.string().max(500).optional(),
});

export async function reconciliationRoutes(app: FastifyInstance) {
  const repo = new BankReconciliationRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get(
    '/statements',
    { preHandler: app.requirePermission('accounting.read') },
    async () => repo.list(),
  );

  app.get<{ Params: { id: string } }>(
    '/statements/:id',
    { preHandler: app.requirePermission('accounting.read') },
    async (req, reply) => {
      const s = await repo.findById(req.params.id);
      if (!s) return reply.code(404).send({ error: 'NotFound' });
      return s;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/statements/:id/summary',
    { preHandler: app.requirePermission('accounting.read') },
    async (req) => repo.summary(req.params.id),
  );

  app.post(
    '/statements',
    { preHandler: app.requirePermission('accounting.post_journal') },
    async (req, reply) => {
      const parsed = statementSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'ValidationError', issues: parsed.error.issues });
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
        action: 'BANK_STATEMENT_IMPORT',
        actorId: req.user.sub,
        targetType: 'BankStatement',
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
    '/statements/:id/auto-match',
    { preHandler: app.requirePermission('accounting.post_journal') },
    async (req) => {
      const result = await repo.autoMatch(req.params.id);
      await audit.record({
        action: 'BANK_STATEMENT_AUTO_MATCH',
        actorId: req.user.sub,
        targetType: 'BankStatement',
        targetId: req.params.id,
        payload: { matched: result.matchedLines, amount: result.matchedAmount },
      });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/lines/:id/match',
    { preHandler: app.requirePermission('accounting.post_journal') },
    async (req, reply) => {
      const parsed = manualMatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      return repo.manualMatch(req.params.id, {
        ...parsed.data,
        userId: req.user.sub,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/lines/:id/unmatch',
    { preHandler: app.requirePermission('accounting.post_journal') },
    async (req) => repo.unmatch(req.params.id),
  );

  /**
   * Scored match candidates for an unmatched line — used by the drawer
   * to surface suggestions before the human confirms one via /match.
   */
  app.get<{ Params: { id: string } }>(
    '/lines/:id/candidates',
    { preHandler: app.requirePermission('accounting.read') },
    async (req) => repo.candidatesFor(req.params.id, 10),
  );
}
