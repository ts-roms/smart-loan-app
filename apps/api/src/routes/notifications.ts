import { NotificationRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const testSchema = z.object({
  channel: z.enum(['EMAIL', 'SMS', 'IN_APP']),
  recipient: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});

export function notificationRoutes(repo: NotificationRepository) {
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', app.authenticate);

    app.get<{ Querystring: { customerId?: string; status?: string; event?: string } }>(
      '/',
      async (req) =>
        repo.list({
          customerId: req.query.customerId,
          status: req.query.status as never,
          event: req.query.event as never,
        }),
    );

    /** Admin-only: fire a TEST notification through the active provider. */
    app.post(
      '/test',
      { preHandler: app.requirePermission('notifications.test') },
      async (req, reply) => {
        const parsed = testSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
        }
        return repo.dispatch({
          event: 'TEST',
          channel: parsed.data.channel,
          recipient: parsed.data.recipient,
          data: { note: parsed.data.note ?? 'sent from /notifications/test' },
        });
      },
    );
  };
}
