/**
 * Cooperative module routes. Six entity types under a single namespace
 * (`/cooperative/*`). Every mutation auto-posts to the GL via the
 * CooperativeRepository — see libs/db/src/repositories/cooperative.repository.ts.
 *
 *   GET /contributions               coop.read
 *   POST /contributions              coop.contribute
 *   GET /savings                     coop.read
 *   POST /savings                    coop.savings
 *   GET /funds                       coop.read
 *   POST /funds                      coop.funds
 *   GET /withdrawals                 coop.read
 *   POST /withdrawals                coop.funds
 *   GET /expenses                    coop.read
 *   POST /expenses                   coop.expense
 *   GET /other-income                coop.read
 *   POST /other-income               coop.income
 *   GET /big-brother                 coop.read
 *   POST /big-brother                coop.big_brother
 */

import { CooperativeRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const contributionSchema = z.object({
  customerId: z.string().uuid(),
  capitalBuildUp: z.number().nonnegative().default(0),
  mortuaryFund: z.number().nonnegative().default(0),
  emergencyFund: z.number().nonnegative().default(0),
  notes: z.string().max(500).optional(),
  contributedAt: z.string().optional(),
});

const savingsSchema = z.object({
  customerId: z.string().uuid(),
  amount: z.number().positive(),
  kind: z.enum(['DEPOSIT', 'WITHDRAWAL']).default('DEPOSIT'),
  notes: z.string().max(500).optional(),
  txnDate: z.string().optional(),
});

const fundTxnSchema = z.object({
  customerId: z.string().uuid().optional(),
  transactionRef: z.string().max(120).optional(),
  sourceOfFunds: z.string().min(1).max(60),
  amount: z.number().positive(),
  txnDate: z.string().optional(),
  notes: z.string().max(500).optional(),
});

const withdrawalSchema = z.object({
  customerId: z.string().uuid().optional(),
  sourceOfFunds: z.string().min(1).max(60),
  amount: z.number().positive(),
  notes: z.string().max(500).optional(),
  txnDate: z.string().optional(),
});

const expenseSchema = z.object({
  type: z.string().min(1).max(120),
  amount: z.number().positive(),
  sourceOfFunds: z.string().min(1).max(60),
  txnDate: z.string().optional(),
  isRecurring: z.boolean().optional(),
  attachments: z.array(z.string().max(500)).max(20).optional(),
  notes: z.string().max(500).optional(),
});

const otherIncomeSchema = z.object({
  type: z.string().min(1).max(120),
  amount: z.number().positive(),
  sourceTo: z.string().min(1).max(60),
  txnDate: z.string().optional(),
  attachments: z.array(z.string().max(500)).max(20).optional(),
  notes: z.string().max(500).optional(),
});

const bigBrotherSchema = z.object({
  name: z.string().min(1).max(120),
  account: z.string().min(1).max(120),
  capital: z.number().positive(),
  periodFrom: z.string(),
  periodTo: z.string(),
  notes: z.string().max(500).optional(),
});

export async function cooperativeRoutes(app: FastifyInstance) {
  const repo = new CooperativeRepository(app.prisma);
  app.addHook('preHandler', app.authenticate);

  // ─── Contributions ────────────────────────────────────────────
  app.get('/contributions',
    { preHandler: app.requirePermission('coop.read') },
    async () => repo.listContributions(),
  );
  app.post('/contributions',
    { preHandler: app.requirePermission('coop.contribute') },
    async (req, reply) => {
      const parsed = contributionSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        return reply.code(201).send(await repo.createContribution({
          ...parsed.data,
          contributedAt: parsed.data.contributedAt ? new Date(parsed.data.contributedAt) : undefined,
          recordedById: req.user.sub,
        }));
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  // ─── Savings ──────────────────────────────────────────────────
  app.get('/savings',
    { preHandler: app.requirePermission('coop.read') },
    async () => repo.listSavings(),
  );
  app.post('/savings',
    { preHandler: app.requirePermission('coop.savings') },
    async (req, reply) => {
      const parsed = savingsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        return reply.code(201).send(await repo.createSavings({
          ...parsed.data,
          txnDate: parsed.data.txnDate ? new Date(parsed.data.txnDate) : undefined,
          recordedById: req.user.sub,
        }));
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  // ─── Funds (in + out) ─────────────────────────────────────────
  app.get('/funds',
    { preHandler: app.requirePermission('coop.read') },
    async () => repo.listFundTxns(),
  );
  app.post('/funds',
    { preHandler: app.requirePermission('coop.funds') },
    async (req, reply) => {
      const parsed = fundTxnSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        return reply.code(201).send(await repo.createFundTxn({
          ...parsed.data,
          txnDate: parsed.data.txnDate ? new Date(parsed.data.txnDate) : undefined,
          authorId: req.user.sub,
        }));
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  app.get('/withdrawals',
    { preHandler: app.requirePermission('coop.read') },
    async () => repo.listWithdrawals(),
  );
  app.post('/withdrawals',
    { preHandler: app.requirePermission('coop.funds') },
    async (req, reply) => {
      const parsed = withdrawalSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        return reply.code(201).send(await repo.createWithdrawal({
          ...parsed.data,
          txnDate: parsed.data.txnDate ? new Date(parsed.data.txnDate) : undefined,
          authorId: req.user.sub,
        }));
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  // ─── Expenses ─────────────────────────────────────────────────
  app.get('/expenses',
    { preHandler: app.requirePermission('coop.read') },
    async () => repo.listExpenses(),
  );
  app.post('/expenses',
    { preHandler: app.requirePermission('coop.expense') },
    async (req, reply) => {
      const parsed = expenseSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        return reply.code(201).send(await repo.createExpense({
          ...parsed.data,
          txnDate: parsed.data.txnDate ? new Date(parsed.data.txnDate) : undefined,
          recordedById: req.user.sub,
        }));
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  // ─── Other income ─────────────────────────────────────────────
  app.get('/other-income',
    { preHandler: app.requirePermission('coop.read') },
    async () => repo.listOtherIncome(),
  );
  app.post('/other-income',
    { preHandler: app.requirePermission('coop.income') },
    async (req, reply) => {
      const parsed = otherIncomeSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        return reply.code(201).send(await repo.createOtherIncome({
          ...parsed.data,
          txnDate: parsed.data.txnDate ? new Date(parsed.data.txnDate) : undefined,
          recordedById: req.user.sub,
        }));
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );

  // ─── Member ledger (rollup for the drawer) ────────────────────
  app.get<{ Params: { customerId: string } }>(
    '/members/:customerId/ledger',
    { preHandler: app.requirePermission('coop.read') },
    async (req, reply) => {
      const ledger = await repo.memberLedger(req.params.customerId);
      if (!ledger) return reply.code(404).send({ error: 'NotFound' });
      return ledger;
    },
  );

  // ─── Big Brother (external capital) ───────────────────────────
  app.get('/big-brother',
    { preHandler: app.requirePermission('coop.read') },
    async () => repo.listBigBrother(),
  );
  app.post('/big-brother',
    { preHandler: app.requirePermission('coop.big_brother') },
    async (req, reply) => {
      const parsed = bigBrotherSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      try {
        return reply.code(201).send(await repo.createBigBrother({
          ...parsed.data,
          periodFrom: new Date(parsed.data.periodFrom),
          periodTo: new Date(parsed.data.periodTo),
          recordedById: req.user.sub,
        }));
      } catch (err) {
        return reply.code(400).send({ error: 'BadRequest', message: (err as Error).message });
      }
    },
  );
}
