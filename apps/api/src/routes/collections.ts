import { CollectionsRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const noteSchema = z.object({
  type: z.enum(['CALL', 'SMS', 'EMAIL', 'VISIT', 'OTHER']).default('OTHER'),
  body: z.string().min(1).max(2000),
});

const ptpSchema = z.object({
  amount: z.number().positive(),
  promisedDate: z.string(),
  note: z.string().max(500).optional(),
});

const resolveSchema = z.object({
  status: z.enum(['HONORED', 'BROKEN', 'CANCELLED']),
});

export async function collectionsRoutes(app: FastifyInstance) {
  const collections = new CollectionsRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  /** Overdue queue — loans with at least one unpaid installment past due. */
  app.get('/queue', async () => collections.overdueQueue());

  // ─── Notes ─────────────────────────────────────────────────────────

  app.get<{ Params: { loanId: string } }>(
    '/loans/:loanId/notes',
    async (req) => collections.listNotes(req.params.loanId),
  );

  app.post<{ Params: { loanId: string } }>(
    '/loans/:loanId/notes',
    async (req, reply) => {
      const parsed = noteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      return reply.code(201).send(
        await collections.addNote(req.params.loanId, {
          type: parsed.data.type,
          body: parsed.data.body,
          createdById: req.user.sub,
        }),
      );
    },
  );

  // ─── Promises to pay ───────────────────────────────────────────────

  app.get<{ Params: { loanId: string } }>(
    '/loans/:loanId/promises',
    async (req) => collections.listPromises(req.params.loanId),
  );

  app.post<{ Params: { loanId: string } }>(
    '/loans/:loanId/promises',
    async (req, reply) => {
      const parsed = ptpSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      return reply.code(201).send(
        await collections.createPromise(req.params.loanId, {
          amount: parsed.data.amount,
          promisedDate: new Date(parsed.data.promisedDate),
          note: parsed.data.note,
          createdById: req.user.sub,
        }),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    '/promises/:id/resolve',
    async (req, reply) => {
      const parsed = resolveSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      return collections.resolvePromise(req.params.id, parsed.data.status);
    },
  );

  // ─── Late-fee accrual job ──────────────────────────────────────────

  app.post(
    '/jobs/accrue-late-fees',
    { preHandler: app.requirePermission('collections.accrue') },
    async (req, reply) => {
      try {
        return await collections.accrueLateFees(new Date(), req.user.sub);
      } catch (err) {
        return reply.code(409).send({
          error: 'AccrualFailed',
          message: (err as Error).message,
        });
      }
    },
  );
}
