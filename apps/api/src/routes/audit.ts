/**
 * Audit log read API. Append-only writes happen inline from the routes
 * that perform privileged actions (via AuditLogRepository.record()); this
 * route only exposes the read side.
 *
 *   GET /audit                       admin.audit_log
 *   GET /audit/distinct/actions      admin.audit_log
 *
 * The list endpoint joins the actor User (for display: name + email) and
 * supports filter-by-action / actor / target / date-range / take.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const listQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  action: z.string().min(1).max(120).optional(),
  targetType: z.string().min(1).max(60).optional(),
  targetId: z.string().min(1).max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  take: z.coerce.number().int().positive().max(500).optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/',
    { preHandler: app.requirePermission('admin.audit_log') },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      const q = parsed.data;
      const rows = await app.prisma.auditEvent.findMany({
        where: {
          actorId: q.actorId,
          action: q.action,
          targetType: q.targetType,
          targetId: q.targetId,
          createdAt: {
            gte: q.from ? new Date(q.from) : undefined,
            lte: q.to ? new Date(q.to) : undefined,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: q.take ?? 100,
        include: { actor: { select: { id: true, name: true, email: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        actorName: r.actor?.name ?? null,
        actorEmail: r.actor?.email ?? null,
        targetType: r.targetType,
        targetId: r.targetId,
        payload: r.payload,
        createdAt: r.createdAt,
      }));
    },
  );

  /** Distinct action labels — drives the filter dropdown. */
  app.get(
    '/distinct/actions',
    { preHandler: app.requirePermission('admin.audit_log') },
    async () => {
      const rows = await app.prisma.auditEvent.findMany({
        distinct: ['action'],
        select: { action: true },
        orderBy: { action: 'asc' },
      });
      return rows.map((r) => r.action);
    },
  );
}
