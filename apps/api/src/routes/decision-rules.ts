import { DecisionRuleRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const conditionSchema = z.object({
  field: z.string().min(1).max(40),
  op: z.enum(['=', '!=', '<', '<=', '>', '>=', 'in', 'not_in']),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
});

const baseSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  priority: z.number().int().min(0).max(99_999).optional(),
  conditions: z.array(conditionSchema).min(1).max(20),
  action: z.enum(['AUTO_APPROVE', 'AUTO_REJECT', 'MANUAL_REVIEW']),
  reason: z.string().max(500).optional(),
  active: z.boolean().optional(),
});

export async function decisionRuleRoutes(app: FastifyInstance) {
  const repo = new DecisionRuleRepository(app.prisma);
  app.addHook('preHandler', app.authenticate);

  app.get('/', async () => repo.list());

  app.post(
    '/',
    { preHandler: app.requirePermission('admin.decision_rules') },
    async (req, reply) => {
      const parsed = baseSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      try {
        return reply.code(201).send(await repo.create(parsed.data));
      } catch (err) {
        return reply.code(409).send({
          error: 'Conflict',
          message: (err as Error).message,
        });
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requirePermission('admin.decision_rules') },
    async (req, reply) => {
      const parsed = baseSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      return repo.update(req.params.id, parsed.data);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requirePermission('admin.decision_rules') },
    async (req) => repo.delete(req.params.id),
  );

  app.post(
    '/seed',
    { preHandler: app.requirePermission('admin.decision_rules') },
    async () => repo.seedDefaults(),
  );
}
