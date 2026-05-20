import { LoanProductRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const DOC_TYPES = [
  'ID_FRONT', 'ID_BACK', 'PROOF_OF_INCOME', 'PROOF_OF_ADDRESS', 'SELFIE',
  'VEHICLE_OR', 'VEHICLE_CR', 'PROPERTY_TITLE', 'TAX_DECLARATION',
] as const;

const TIER_VALUES = ['A', 'B', 'C', 'D', 'F'] as const;

const tierMap = z
  .record(
    z.enum(TIER_VALUES),
    z.number().min(0).max(1).nullable(),
  )
  .nullable()
  .optional();

const baseSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  collateralKind: z.enum(['NONE', 'VEHICLE', 'PROPERTY']).optional(),
  requiredKycDocs: z.array(z.enum(DOC_TYPES)).optional(),

  minPrincipal: z.number().nonnegative(),
  maxPrincipal: z.number().positive(),
  minTermMonths: z.number().int().positive(),
  maxTermMonths: z.number().int().positive(),
  defaultRate: z.number().min(0).max(1),
  minRate: z.number().min(0).max(1),
  maxRate: z.number().min(0).max(1),
  maxLoanToValue: z.number().min(0).max(1).nullable().optional(),

  processingFeeRate: z.number().min(0).max(1).optional(),
  processingFeeFlat: z.number().min(0).optional(),
  documentaryStampRate: z.number().min(0).max(1).optional(),
  lateFeeDailyRate: z.number().min(0).max(1).optional(),
  lateFeeCapFraction: z.number().min(0).max(1).optional(),
  lateFeeGraceDays: z.number().int().min(0).max(365).optional(),
  preTerminationFeeRate: z.number().min(0).max(1).optional(),

  interestMethod: z.enum(['DECLINING', 'FLAT']).optional(),
  paymentFrequency: z.enum(['MONTHLY', 'BIWEEKLY', 'WEEKLY']).optional(),

  rateByTier: tierMap,
  ltvByTier: z
    .record(z.enum(TIER_VALUES), z.number().min(0).max(1))
    .nullable()
    .optional(),

  active: z.boolean().optional(),
});

const createSchema = baseSchema.extend({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, {
    message: 'Code must be UPPER_SNAKE_CASE',
  }),
});

const updateSchema = baseSchema.partial();

export async function loanProductRoutes(app: FastifyInstance) {
  const products = new LoanProductRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get('/', async () => products.list());

  app.get<{ Params: { code: string } }>('/:code', async (req, reply) => {
    const p = await products.findByCode(req.params.code);
    if (!p) return reply.code(404).send({ error: 'NotFound' });
    return p;
  });

  /** Create a brand-new product. ADMIN only. */
  app.post(
    '/',
    { preHandler: app.requirePermission('products.write') },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      try {
        return reply.code(201).send(await products.create(parsed.data));
      } catch (err) {
        return reply.code(409).send({
          error: 'Conflict',
          message: (err as Error).message,
        });
      }
    },
  );

  app.patch<{ Params: { code: string } }>(
    '/:code',
    { preHandler: app.requirePermission('products.write') },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      return products.update(req.params.code, parsed.data);
    },
  );

  app.delete<{ Params: { code: string } }>(
    '/:code',
    { preHandler: app.requirePermission('products.write') },
    async (req, reply) => {
      try {
        return await products.delete(req.params.code);
      } catch (err) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Product cannot be deleted — loans reference it.',
        });
      }
    },
  );

  app.post(
    '/seed',
    { preHandler: app.requirePermission('products.write') },
    async () => products.seedDefaults(),
  );
}
