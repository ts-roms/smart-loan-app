/**
 * Self-serve borrower portal routes.
 *
 * Auth: requires a logged-in CUSTOMER. Every action is implicitly scoped
 * to the `Customer` row linked to `User.customerId`. No path needs the
 * customer id — we resolve it from the JWT.
 */

import {
  CreditScoreRepository,
  KycRepository,
  LoanRepository,
  PaymentIntentRepository,
  type PrismaClient,
} from '@loan/db';
import { validateKyc } from '@loan/kyc';
import { MockProvider } from '@loan/payments';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const applySchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
  vehicle: z.object({
    kind: z.enum(['CAR', 'MOTORCYCLE']),
    make: z.string().min(1).max(80),
    model: z.string().min(1).max(80),
    year: z.number().int().min(1900).max(2100),
    plateNumber: z.string().max(40).optional(),
    chassisNumber: z.string().max(80).optional(),
    engineNumber: z.string().max(80).optional(),
    color: z.string().max(40).optional(),
    appraisedValue: z.number().positive(),
    notes: z.string().max(500).optional(),
  }).optional(),
  property: z.object({
    propertyType: z.string().min(1).max(80),
    address: z.string().min(1).max(500),
    city: z.string().min(1).max(80),
    province: z.string().max(80).optional(),
    postalCode: z.string().max(20).optional(),
    titleNumber: z.string().max(80).optional(),
    taxDecNumber: z.string().max(80).optional(),
    areaSqm: z.number().positive().optional(),
    appraisedValue: z.number().positive(),
    notes: z.string().max(500).optional(),
  }).optional(),
  applicationSelfieUrl: z.string().max(500).optional(),
});

const kycSubmitSchema = z.object({
  documentType: z.enum([
    'ID_FRONT', 'ID_BACK', 'PROOF_OF_INCOME', 'PROOF_OF_ADDRESS', 'SELFIE',
    'VEHICLE_OR', 'VEHICLE_CR', 'PROPERTY_TITLE', 'TAX_DECLARATION',
  ]),
  documentUrl: z.string().min(1),
  notes: z.string().max(500).optional(),
});

const intentSchema = z.object({
  loanId: z.string().uuid(),
  amount: z.number().positive(),
});

async function resolveCustomerId(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { role: true, customerId: true },
  });
  if (!user || user.role !== 'CUSTOMER' || !user.customerId) {
    reply.code(403).send({
      error: 'Forbidden',
      message: 'Portal requires a CUSTOMER account linked to a customer row.',
    });
    return null;
  }
  return user.customerId;
}

export async function portalRoutes(app: FastifyInstance) {
  const loans = new LoanRepository(app.prisma);
  const scores = new CreditScoreRepository(app.prisma);
  const kyc = new KycRepository(app.prisma);
  const baseUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
  const provider = new MockProvider({ baseUrl });
  const intents = new PaymentIntentRepository(app.prisma, provider);

  app.addHook('preHandler', app.authenticate);

  /** Current borrower's profile, linked customer row, and a summary. */
  app.get('/me', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const customer = await app.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      return reply.code(404).send({ error: 'NotFound', message: 'Customer record missing.' });
    }
    const score = await scores.latestForCustomer(customerId);
    return {
      customer,
      score: score ? { score: score.score, tier: score.tier, computedAt: score.computedAt } : null,
    };
  });

  /** All loans owned by the calling customer. */
  app.get('/loans', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    return app.prisma.loanApplication.findMany({
      where: { customerId },
      orderBy: { submittedAt: 'desc' },
    });
  });

  app.get<{ Params: { id: string } }>('/loans/:id', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const loan = await loans.findById(req.params.id);
    if (!loan || loan.customerId !== customerId) {
      return reply.code(404).send({ error: 'NotFound' });
    }
    return loan;
  });

  /**
   * Borrower self-signs. Same shape as the officer-mediated path; captures
   * IP from the request so the audit trail records *where* the customer
   * was when they signed.
   */
  app.post<{ Params: { id: string }; Body: { signatureUrl: string } }>(
    '/loans/:id/sign-borrower',
    async (req, reply) => {
      const customerId = await resolveCustomerId(req, reply, app.prisma);
      if (!customerId) return;
      const loan = await app.prisma.loanApplication.findUnique({
        where: { id: req.params.id },
        select: { customerId: true },
      });
      if (!loan || loan.customerId !== customerId) {
        return reply.code(404).send({ error: 'NotFound' });
      }
      const url = req.body?.signatureUrl;
      if (!url || typeof url !== 'string' || url.length === 0) {
        return reply.code(400).send({ error: 'BadRequest', message: 'signatureUrl required' });
      }
      const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip;
      return app.prisma.loanApplication.update({
        where: { id: req.params.id },
        data: {
          borrowerSignatureUrl: url,
          borrowerSignedAt: new Date(),
          borrowerSignedFromIp: ip,
        },
      });
    },
  );

  app.post('/loans/apply', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const score = await scores.latestForCustomer(customerId);
    try {
      const created = await loans.apply({
        ...parsed.data,
        customerId,
        submittedById: req.user.sub,
        creditScoreAtApply: score?.score ?? null,
        tierAtApply: score?.tier ?? null,
      });
      return reply.code(201).send(created);
    } catch (err) {
      return reply.code(400).send({
        error: 'BadRequest',
        message: (err as Error).message,
        issues: (err as Error & { issues?: unknown }).issues,
      });
    }
  });

  // ─── KYC ───────────────────────────────────────────────────────────

  app.get('/kyc', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const docs = await kyc.listForCustomer(customerId);
    return { docs, status: validateKyc(docs) };
  });

  app.post('/kyc', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsed = kycSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    return reply.code(201).send(
      await kyc.submit({
        customerId,
        documentType: parsed.data.documentType,
        documentUrl: parsed.data.documentUrl,
        notes: parsed.data.notes,
        submittedById: req.user.sub,
      }),
    );
  });

  // ─── Payments ──────────────────────────────────────────────────────

  /**
   * Create a payment intent for one of MY loans. Validates ownership before
   * delegating to the generic PaymentIntentRepository.
   */
  app.post('/payments/intents', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsed = intentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const loan = await app.prisma.loanApplication.findUnique({
      where: { id: parsed.data.loanId },
      select: { customerId: true },
    });
    if (!loan || loan.customerId !== customerId) {
      return reply.code(404).send({ error: 'NotFound' });
    }
    const intent = await intents.create({
      loanId: parsed.data.loanId,
      amount: parsed.data.amount,
      idempotencyKey: randomUUID(),
      webhookUrl: `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}`,
      createdById: req.user.sub,
    });
    return reply.code(201).send(intent);
  });

  app.get<{ Params: { id: string } }>('/payments/intents/:id', async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const intent = await intents.findById(req.params.id);
    if (!intent) return reply.code(404).send({ error: 'NotFound' });
    const loan = await app.prisma.loanApplication.findUnique({
      where: { id: intent.loanId },
      select: { customerId: true },
    });
    if (loan?.customerId !== customerId) {
      return reply.code(404).send({ error: 'NotFound' });
    }
    return intent;
  });
}
