/**
 * IFRS 9 / PFRS 9 expected-credit-loss endpoints.
 *
 *   GET  /ecl/runs              — history (last 60)
 *   POST /ecl/runs              — recompute as of now (or for a specific period)
 *
 * Recomputation is gated on `accounting.accrue` since it touches the
 * portfolio's provision state. Journal posting (DR Impairment Expense,
 * CR Allowance for Loan Losses) is deferred — the snapshot rows are
 * the authoritative source until the impairment chart-of-accounts wiring
 * lands.
 */

import { AuditLogRepository, EclRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const runSchema = z.object({
  /** Defaults to the first day of the current month. */
  periodStart: z.string().optional(),
  /** Defaults to today (period-end == as-of). */
  periodEnd: z.string().optional(),
  notes: z.string().max(500).optional(),
});

export async function eclRoutes(app: FastifyInstance) {
  const repo = new EclRepository(app.prisma);
  const audit = new AuditLogRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get(
    '/runs',
    { preHandler: app.requirePermission('accounting.read') },
    async () => repo.list(),
  );

  app.post(
    '/runs',
    { preHandler: app.requirePermission('accounting.accrue') },
    async (req, reply) => {
      const parsed = runSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      const now = new Date();
      const periodEnd = parsed.data.periodEnd
        ? new Date(parsed.data.periodEnd)
        : now;
      const periodStart = parsed.data.periodStart
        ? new Date(parsed.data.periodStart)
        : new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
      const result = await repo.run({
        periodStart,
        periodEnd,
        computedById: req.user.sub,
        notes: parsed.data.notes,
      });
      await audit.record({
        action: 'ECL_RUN',
        actorId: req.user.sub,
        targetType: 'EclRun',
        targetId: result.id,
        payload: {
          totalEcl: result.totalEcl,
          stages: {
            STAGE_1: result.byStage.STAGE_1.count,
            STAGE_2: result.byStage.STAGE_2.count,
            STAGE_3: result.byStage.STAGE_3.count,
          },
        },
      });
      return reply.code(201).send(result);
    },
  );
}
