import { KycRepository } from '@loan/db';
import { validateKyc } from '@loan/kyc';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const submitSchema = z.object({
  customerId: z.string().uuid(),
  documentType: z.enum(['ID_FRONT', 'ID_BACK', 'PROOF_OF_INCOME', 'PROOF_OF_ADDRESS', 'SELFIE']),
  documentUrl: z.string().min(1),
  notes: z.string().max(500).optional(),
});

const decisionSchema = z.object({
  status: z.enum(['VERIFIED', 'REJECTED']),
  reason: z.string().max(500).optional(),
});

export async function kycRoutes(app: FastifyInstance) {
  const kyc = new KycRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  /** All KYC submissions for a customer. */
  app.get<{ Querystring: { customerId?: string } }>('/', async (req, reply) => {
    if (!req.query.customerId) {
      return reply.code(400).send({ error: 'BadRequest', message: 'customerId required' });
    }
    return kyc.listForCustomer(req.query.customerId);
  });

  /** Submit a document for verification. */
  app.post('/', async (req, reply) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    return reply.code(201).send(
      await kyc.submit({ ...parsed.data, submittedById: req.user.sub }),
    );
  });

  /** Officer's decide call — verify or reject a submitted doc. */
  app.post<{ Params: { id: string } }>('/:id/decide', async (req, reply) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    return kyc.decide(req.params.id, {
      status: parsed.data.status,
      reason: parsed.data.reason,
      decidedById: req.user.sub,
    });
  });

  /** Read-only summary: which doc types are still pending? */
  app.get<{ Params: { customerId: string } }>(
    '/customers/:customerId/status',
    async (req) => {
      const docs = await kyc.listForCustomer(req.params.customerId);
      return validateKyc(docs);
    },
  );
}
