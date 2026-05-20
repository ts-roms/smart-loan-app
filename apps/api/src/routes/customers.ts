import { CustomerRepository } from '@loan/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const customerSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  middleName: z.string().max(80).optional(),
  dateOfBirth: z.string(),
  phone: z.string().max(40),
  email: z.string().email().optional(),
  address: z.string().max(500),
  city: z.string().max(80),
  province: z.string().max(80).optional(),
  postalCode: z.string().max(20).optional(),
  governmentIdType: z.enum(['PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID', 'SSS', 'TIN', 'OTHER']),
  governmentIdNumber: z.string().max(60),
  employmentStatus: z.enum(['EMPLOYED', 'SELF_EMPLOYED', 'UNEMPLOYED', 'RETIRED', 'STUDENT']),
  employerName: z.string().max(200).optional(),
  jobTitle: z.string().max(120).optional(),
  monthlyIncome: z.number().nonnegative(),
  yearsAtCurrentJob: z.number().nonnegative().optional(),
});

export async function customerRoutes(app: FastifyInstance) {
  const customers = new CustomerRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get('/', async () => customers.list());

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const c = await customers.findById(req.params.id);
    if (!c) return reply.code(404).send({ error: 'NotFound' });
    return c;
  });

  app.post('/', async (req, reply) => {
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const created = await customers.create({
      ...parsed.data,
      dateOfBirth: new Date(parsed.data.dateOfBirth),
    });
    // Best-effort AML screen — runs against the mock watchlist by default.
    // Errors are non-fatal; a scheduled job picks up PENDING customers
    // on the next tick.
    void app.screening.screen(created.id).catch(() => undefined);
    return reply.code(201).send(created);
  });

  /**
   * Customer rollup — used by the drawer for a quick view without
   * navigating off the current page. Returns the base customer record
   * plus active-loans count and outstanding principal across all
   * open loans (status in DISBURSED / ACTIVE / DEFAULTED).
   */
  app.get<{ Params: { id: string } }>('/:id/summary', async (req, reply) => {
    const customer = await customers.findById(req.params.id);
    if (!customer) return reply.code(404).send({ error: 'NotFound' });

    const loans = await app.prisma.loanApplication.findMany({
      where: {
        customerId: customer.id,
        status: { in: ['DISBURSED', 'ACTIVE', 'DEFAULTED'] },
      },
      include: {
        schedule: {
          where: { paidInFullAt: null },
          select: { totalDue: true, principalPaid: true },
        },
      },
    });

    let outstanding = 0;
    for (const l of loans) {
      for (const s of l.schedule) {
        outstanding += Number(s.totalDue) - Number(s.principalPaid);
      }
    }

    const totalLoansCount = await app.prisma.loanApplication.count({
      where: { customerId: customer.id },
    });

    return {
      customer,
      activeLoansCount: loans.length,
      totalLoansCount,
      outstanding: Math.round(outstanding * 100) / 100,
      activeLoans: loans.map((l) => ({
        id: l.id,
        number: l.number,
        productCode: l.productCode,
        principal: l.principal,
        status: l.status,
        disbursedAt: l.disbursedAt,
      })),
    };
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const parsed = customerSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    return customers.update(req.params.id, {
      ...parsed.data,
      dateOfBirth: parsed.data.dateOfBirth ? new Date(parsed.data.dateOfBirth) : undefined,
    });
  });
}
