/**
 * Job definitions. Each job is a pure function that uses the repos to do
 * its work; the scheduler in `@loan/db.JobRepository` handles registration,
 * cron firing, and persistence of each run.
 *
 * To add a new scheduled job:
 *   1. Write the function below.
 *   2. Append it to `buildJobDefinitions()`.
 *   3. It auto-registers on next API boot.
 */

import {
  AccountingRepository,
  CollectionsRepository,
  NotificationRepository,
  ScreeningRepository,
  type PrismaClient,
} from '@loan/db';
import type { JobDefinition } from '@loan/jobs';

export function buildJobDefinitions(
  prisma: PrismaClient,
  notifications: NotificationRepository,
  screening: ScreeningRepository,
): JobDefinition[] {
  const accounting = new AccountingRepository(prisma);
  const collections = new CollectionsRepository(prisma);

  return [
    {
      name: 'accrue-interest-monthly',
      description: 'Post monthly interest accruals for the current month.',
      defaultCron: '0 1 1 * *', // 01:00 on the 1st of each month
      fn: async () => {
        const now = new Date();
        return accounting.accrueMonthlyInterest(
          { year: now.getFullYear(), month: now.getMonth() + 1 },
          systemUserId(),
        );
      },
    },
    {
      name: 'accrue-late-fees-daily',
      description: 'Post late fees on overdue installments according to product policy.',
      defaultCron: '0 2 * * *', // 02:00 every day
      fn: async () => collections.accrueLateFees(new Date(), systemUserId()),
    },
    {
      name: 'payment-due-soon-reminders',
      description: 'Notify borrowers of payments due in the next 3 days.',
      defaultCron: '0 9 * * *', // 09:00 every day
      fn: async () => sendDueSoonReminders(prisma, notifications),
    },
    {
      name: 'payment-overdue-reminders',
      description: 'Notify borrowers of payments overdue 1 / 7 / 30 days.',
      defaultCron: '0 10 * * *', // 10:00 every day
      fn: async () => sendOverdueReminders(prisma, notifications),
    },
    {
      name: 'pending-screenings',
      description: 'Re-run AML screening on any PENDING customers.',
      defaultCron: '*/15 * * * *', // every 15 minutes
      fn: async () => runPendingScreenings(prisma, screening),
    },
  ];
}

const dayMs = 86_400_000;

async function sendDueSoonReminders(
  prisma: PrismaClient,
  notifications: NotificationRepository,
): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 3 * dayMs);
  const rows = await prisma.loanSchedule.findMany({
    where: {
      paidInFullAt: null,
      dueDate: { gte: now, lte: horizon },
      loan: { status: { in: ['ACTIVE', 'DISBURSED'] } },
    },
    include: {
      loan: { include: { customer: true } },
    },
  });
  let sent = 0;
  let skipped = 0;
  for (const inst of rows) {
    const c = inst.loan.customer;
    if (!c.email && !c.phone) {
      skipped += 1;
      continue;
    }
    if (c.email) {
      await notifications.dispatch({
        event: 'PAYMENT_DUE_SOON',
        channel: 'EMAIL',
        recipient: c.email,
        data: {
          customerName: `${c.firstName} ${c.lastName}`,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          dueDate: inst.dueDate.toISOString().slice(0, 10),
        },
        refType: 'LoanSchedule',
        refId: inst.id,
        customerId: c.id,
      });
      sent += 1;
    }
    if (c.phone) {
      await notifications.dispatch({
        event: 'PAYMENT_DUE_SOON',
        channel: 'SMS',
        recipient: c.phone,
        data: {
          customerName: c.firstName,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          dueDate: inst.dueDate.toISOString().slice(0, 10),
        },
        refType: 'LoanSchedule',
        refId: inst.id,
        customerId: c.id,
      });
      sent += 1;
    }
  }
  return { sent, skipped };
}

async function sendOverdueReminders(
  prisma: PrismaClient,
  notifications: NotificationRepository,
): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  // Send reminders at the 1, 7, 30 day overdue marks specifically — avoids
  // pinging the customer every single day until they pay.
  const targetDays = new Set([1, 7, 30]);
  const rows = await prisma.loanSchedule.findMany({
    where: {
      paidInFullAt: null,
      dueDate: { lt: now },
      loan: { status: { in: ['ACTIVE', 'DISBURSED', 'DEFAULTED'] } },
    },
    include: { loan: { include: { customer: true } } },
  });
  let sent = 0;
  let skipped = 0;
  for (const inst of rows) {
    const days = Math.floor((now.getTime() - inst.dueDate.getTime()) / dayMs);
    if (!targetDays.has(days)) {
      skipped += 1;
      continue;
    }
    const c = inst.loan.customer;
    if (c.email) {
      await notifications.dispatch({
        event: 'PAYMENT_OVERDUE',
        channel: 'EMAIL',
        recipient: c.email,
        data: {
          customerName: `${c.firstName} ${c.lastName}`,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          daysOverdue: days,
        },
        refType: 'LoanSchedule',
        refId: inst.id,
        customerId: c.id,
      });
      sent += 1;
    }
    if (c.phone) {
      await notifications.dispatch({
        event: 'PAYMENT_OVERDUE',
        channel: 'SMS',
        recipient: c.phone,
        data: {
          customerName: c.firstName,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          daysOverdue: days,
        },
        refType: 'LoanSchedule',
        refId: inst.id,
        customerId: c.id,
      });
      sent += 1;
    }
  }
  return { sent, skipped };
}

async function runPendingScreenings(
  prisma: PrismaClient,
  screening: ScreeningRepository,
): Promise<{ screened: number }> {
  // Customers whose latest screening is PENDING, or who have no screening row.
  const customers = await prisma.customer.findMany({
    where: {
      OR: [
        { amlScreenings: { none: {} } },
        {
          amlScreenings: {
            some: { status: 'PENDING' },
          },
        },
      ],
    },
    take: 50,
  });
  let screened = 0;
  for (const c of customers) {
    try {
      await screening.screen(c.id);
      screened += 1;
    } catch {
      // Ignore individual failures; next tick will retry.
    }
  }
  return { screened };
}

/**
 * Placeholder for the "system" user id that job-posted entries are attributed
 * to. In a fuller system you'd seed a real `system@loan.local` user; for now
 * we use a sentinel that any post-time auditing can map to "scheduled job".
 */
function systemUserId(): string {
  return process.env.SYSTEM_USER_ID ?? '00000000-0000-0000-0000-000000000000';
}
