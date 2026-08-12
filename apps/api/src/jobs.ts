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
  AnnualDocumentRepository,
  AuditLogRepository,
  CollectionsRepository,
  LeaseRepository,
  NotificationRepository,
  ScreeningRepository,
  runReconciliation,
  type PrismaClient,
} from "@loan/db";
import type { JobDefinition } from "@loan/jobs";

import { RetentionService } from "./features/compliance/retention.service";

export function buildJobDefinitions(
  prisma: PrismaClient,
  notifications: NotificationRepository,
  screening: ScreeningRepository,
): JobDefinition[] {
  const accounting = new AccountingRepository(prisma);
  const collections = new CollectionsRepository(prisma);
  const annualDocs = new AnnualDocumentRepository(prisma);
  const leases = new LeaseRepository(prisma);

  return [
    {
      name: "accrue-interest-monthly",
      description: "Post monthly interest accruals for the current month.",
      defaultCron: "0 1 1 * *", // 01:00 on the 1st of each month
      fn: async () => {
        const now = new Date();
        return accounting.accrueMonthlyInterest(
          { year: now.getFullYear(), month: now.getMonth() + 1 },
          systemUserId(),
        );
      },
    },
    {
      name: "accrue-late-fees-daily",
      description:
        "Post late fees on overdue installments according to product policy.",
      defaultCron: "0 2 * * *", // 02:00 every day
      fn: async () => collections.accrueLateFees(new Date(), systemUserId()),
    },
    {
      name: "payment-due-soon-reminders",
      description: "Notify borrowers of payments due in the next 3 days.",
      defaultCron: "0 9 * * *", // 09:00 every day
      fn: async () => sendDueSoonReminders(prisma, notifications),
    },
    {
      name: "payment-overdue-reminders",
      description: "Notify borrowers of payments overdue 1 / 7 / 30 days.",
      defaultCron: "0 10 * * *", // 10:00 every day
      fn: async () => sendOverdueReminders(prisma, notifications),
    },
    {
      name: "pending-screenings",
      description: "Re-run AML screening on any PENDING customers.",
      defaultCron: "*/15 * * * *", // every 15 minutes
      fn: async () => runPendingScreenings(prisma, screening),
    },
    {
      name: "annual-doc-status-refresh",
      description:
        "recompute annual-doc statuses (VALID / EXPIRING_SOON / EXPIRED) from current dates.",
      defaultCron: "0 0 * * *", // 00:00 every day
      fn: async () => annualDocs.refreshStatuses(),
    },
    {
      name: "annual-doc-expiry-reminders",
      description:
        "notify borrowers about renewable docs (insurance / RPT) expiring in the next 30 days, plus an escalation when already expired.",
      defaultCron: "0 8 * * *", // 08:00 every day
      fn: async () => sendAnnualDocReminders(prisma, notifications, annualDocs),
    },
    {
      name: "lease-end-of-term-notices",
      description:
        "fire 60-day end-of-term notice for active leases approaching their lease term end. Idempotent via LeaseAgreement.endOfTermNoticeSentAt.",
      defaultCron: "0 11 * * *", // 11:00 every day
      fn: async () => sendLeaseEndOfTermNotices(prisma, notifications, leases),
    },
    {
      name: "lease-maintenance-reminders",
      description:
        "fire 6-month maintenance reminder per active lease. Cadence is set per-product (maintenanceReminderMonths).",
      defaultCron: "0 12 * * *", // 12:00 every day
      fn: async () =>
        sendLeaseMaintenanceReminders(prisma, notifications, leases),
    },
    {
      name: "lease-pull-out-warnings",
      description:
        "when a non-employee lease has missed-payment streak >= threshold-1, fire a pre-pull-out warning so they can cure before the next missed payment triggers vehicle recovery.",
      defaultCron: "0 13 * * *", // 13:00 every day
      fn: async () => sendLeasePullOutWarnings(prisma, notifications, leases),
    },
    {
      name: "ledger-reconciliation",
      description:
        "Assert the ledger against itself: trial balance ties, every entry balances, no duplicate auto-posts, instalment progress within bounds, and Loans Receivable agrees with outstanding principal plus accrued fees. THROWS on a finding, so the run shows as FAILED in /jobs rather than passing quietly with a note nobody reads.",
      // 04:30 — after the retention purge and the overnight accruals,
      // so it reconciles the state the operators will actually see when
      // they arrive, not a mid-maintenance snapshot.
      defaultCron: "30 4 * * *",
      fn: async () => {
        const result = await runReconciliation(prisma);
        if (!result.ok) {
          const failed = result.checks.filter((c) => !c.ok);
          /*
           * Throwing rather than returning is deliberate. A JobRun that
           * SUCCEEDED with a warning in its result payload is a warning
           * nobody sees; a FAILED run is visible on the jobs page and in
           * whatever watches it. A ledger that disagrees with itself is
           * exactly the thing that should page someone.
           */
          throw new Error(
            `Reconciliation failed: ${failed.map((c) => c.summary).join(" | ")}`,
          );
        }
        return result;
      },
    },
    {
      name: "data-retention-purge",
      description:
        "Compliance / Data Privacy Act §11(b). Delete audit-event, notification, and job-run rows older than the per-tenant retention policy. Defaults: 5y / 1y / 90d. Set to 0 in /compliance/retention-policy to opt-out per table.",
      // 03:30 every day — well after any midnight accruals + before
      // operators start their morning. Run inside the maintenance
      // window so the deleteMany scans don't compete with user
      // traffic.
      defaultCron: "30 3 * * *",
      fn: async () => {
        // System actor — same sentinel used by the other automated
        // jobs. The audit row attributes the purge to "scheduled
        // tick" rather than any human.
        const retention = new RetentionService(
          prisma,
          new AuditLogRepository(prisma),
        );
        return retention.runPurge({ actorId: systemUserId() });
      },
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
      loan: { status: { in: ["ACTIVE", "DISBURSED"] } },
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
        event: "PAYMENT_DUE_SOON",
        channel: "EMAIL",
        recipient: c.email,
        data: {
          customerName: `${c.firstName} ${c.lastName}`,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          dueDate: inst.dueDate.toISOString().slice(0, 10),
        },
        refType: "LoanSchedule",
        refId: inst.id,
        refNumber: inst.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    if (c.phone) {
      await notifications.dispatch({
        event: "PAYMENT_DUE_SOON",
        channel: "SMS",
        recipient: c.phone,
        data: {
          customerName: c.firstName,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          dueDate: inst.dueDate.toISOString().slice(0, 10),
        },
        refType: "LoanSchedule",
        refId: inst.id,
        refNumber: inst.loan.number,
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
      loan: { status: { in: ["ACTIVE", "DISBURSED", "DEFAULTED"] } },
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
        event: "PAYMENT_OVERDUE",
        channel: "EMAIL",
        recipient: c.email,
        data: {
          customerName: `${c.firstName} ${c.lastName}`,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          daysOverdue: days,
        },
        refType: "LoanSchedule",
        refId: inst.id,
        refNumber: inst.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    if (c.phone) {
      await notifications.dispatch({
        event: "PAYMENT_OVERDUE",
        channel: "SMS",
        recipient: c.phone,
        data: {
          customerName: c.firstName,
          loanNumber: inst.loan.number,
          amount: Number(inst.totalDue),
          daysOverdue: days,
        },
        refType: "LoanSchedule",
        refId: inst.id,
        refNumber: inst.loan.number,
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
            some: { status: "PENDING" },
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
 * Annual document reminder dispatcher. Sends ANNUAL_DOC_EXPIRING for docs
 * inside the 30-day window and ANNUAL_DOC_EXPIRED for ones past `expiresAt`.
 *
 * Each row is reminded at most once every 14 days to avoid spam; the
 * `lastReminderAt` field gates re-sends. Customers without contact info
 * are counted as skipped (not failed) — the system can still surface
 * the row on the dashboard for manual outreach.
 */
async function sendAnnualDocReminders(
  prisma: PrismaClient,
  notifications: NotificationRepository,
  annualDocs: AnnualDocumentRepository,
): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  const minReminderGap = 14 * dayMs;

  const due = await annualDocs.listExpiring(30, now);
  let sent = 0;
  let skipped = 0;

  for (const doc of due) {
    if (
      doc.lastReminderAt &&
      now.getTime() - doc.lastReminderAt.getTime() < minReminderGap
    ) {
      skipped += 1;
      continue;
    }
    const customer = await prisma.customer.findUnique({
      where: { id: doc.loan.customerId },
    });
    if (!customer || (!customer.email && !customer.phone)) {
      skipped += 1;
      continue;
    }

    const expired = doc.expiresAt < now;
    const event = expired ? "ANNUAL_DOC_EXPIRED" : "ANNUAL_DOC_EXPIRING";
    const daysOut = Math.ceil(
      Math.abs(doc.expiresAt.getTime() - now.getTime()) / dayMs,
    );
    const data = {
      customerName: `${customer.firstName} ${customer.lastName}`,
      loanNumber: doc.loan.number,
      docType: doc.type,
      docName: doc.name,
      expiresAt: doc.expiresAt.toISOString().slice(0, 10),
      daysOut,
    };

    if (customer.email) {
      await notifications.dispatch({
        event,
        channel: "EMAIL",
        recipient: customer.email,
        data,
        refType: "AnnualDocument",
        refId: doc.id,
        refNumber: doc.loan.number,
        customerId: customer.id,
      });
      sent += 1;
    }
    if (customer.phone) {
      await notifications.dispatch({
        event,
        channel: "SMS",
        recipient: customer.phone,
        data,
        refType: "AnnualDocument",
        refId: doc.id,
        refNumber: doc.loan.number,
        customerId: customer.id,
      });
      sent += 1;
    }
    await annualDocs.markReminderSent(doc.id, now);
  }

  return { sent, skipped };
}

// ── Lease-to-Own jobs ───────────────────────────────────────────────

/**
 * Estimate the lease term end as `loan.disbursedAt + termMonths`. The
 * formal "lease term end" isn't a separate field — it's the same as the
 * loan's term end. We fire the notice when that date is
 * within 60 days from today.
 */
async function sendLeaseEndOfTermNotices(
  prisma: PrismaClient,
  notifications: NotificationRepository,
  _leases: LeaseRepository,
): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 60 * dayMs);

  const leases = await prisma.leaseAgreement.findMany({
    where: {
      status: "ACTIVE",
      // Already-notified leases are skipped via lastNoticeAt below.
      endOfTermNoticeSentAt: null,
    },
    include: {
      loan: {
        select: {
          id: true,
          number: true,
          disbursedAt: true,
          termMonths: true,
          customer: true,
        },
      },
    },
  });

  let sent = 0;
  let skipped = 0;
  for (const l of leases) {
    if (!l.loan.disbursedAt) {
      skipped += 1;
      continue;
    }
    const termEnd = new Date(l.loan.disbursedAt);
    termEnd.setMonth(termEnd.getMonth() + l.loan.termMonths);
    if (termEnd > horizon) {
      skipped += 1;
      continue;
    }
    const c = l.loan.customer;
    if (!c.email && !c.phone) {
      skipped += 1;
      continue;
    }
    const data = {
      customerName: `${c.firstName} ${c.lastName}`,
      loanNumber: l.loan.number,
      residualValue: Number(l.residualValue).toFixed(2),
      termEnd: termEnd.toISOString().slice(0, 10),
    };
    if (c.email) {
      await notifications.dispatch({
        event: "LEASE_END_OF_TERM",
        channel: "EMAIL",
        recipient: c.email,
        data,
        refType: "LeaseAgreement",
        refId: l.id,
        refNumber: l.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    if (c.phone) {
      await notifications.dispatch({
        event: "LEASE_END_OF_TERM",
        channel: "SMS",
        recipient: c.phone,
        data,
        refType: "LeaseAgreement",
        refId: l.id,
        refNumber: l.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    await prisma.leaseAgreement.update({
      where: { id: l.id },
      data: { endOfTermNoticeSentAt: new Date() },
    });
  }
  return { sent, skipped };
}

/**
 * 6-month (configurable per-product) maintenance reminder
 * for active leases. We check `lastMaintenanceReminderAt` to avoid
 * sending too often, and use the product's `maintenanceReminderMonths`
 * for the cadence.
 */
async function sendLeaseMaintenanceReminders(
  prisma: PrismaClient,
  notifications: NotificationRepository,
  leases: LeaseRepository,
): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  const rows = await prisma.leaseAgreement.findMany({
    where: { status: "ACTIVE" },
    include: {
      loan: {
        include: {
          customer: true,
          product: { select: { maintenanceReminderMonths: true } },
        },
      },
    },
  });

  let sent = 0;
  let skipped = 0;
  for (const l of rows) {
    const cadenceMonths = l.loan.product?.maintenanceReminderMonths ?? 6;
    const cadenceMs = cadenceMonths * 30 * dayMs; // approx
    const last = l.lastMaintenanceReminderAt;
    if (last && now.getTime() - last.getTime() < cadenceMs) {
      skipped += 1;
      continue;
    }
    const c = l.loan.customer;
    if (!c.email && !c.phone) {
      skipped += 1;
      continue;
    }
    const data = {
      customerName: `${c.firstName} ${c.lastName}`,
      loanNumber: l.loan.number,
    };
    if (c.email) {
      await notifications.dispatch({
        event: "LEASE_MAINTENANCE_REMINDER",
        channel: "EMAIL",
        recipient: c.email,
        data,
        refType: "LeaseAgreement",
        refId: l.id,
        refNumber: l.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    if (c.phone) {
      await notifications.dispatch({
        event: "LEASE_MAINTENANCE_REMINDER",
        channel: "SMS",
        recipient: c.phone,
        data,
        refType: "LeaseAgreement",
        refId: l.id,
        refNumber: l.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    await leases.markMaintenanceReminderSent(l.loanId);
  }
  return { sent, skipped };
}

/**
 * pre-pull-out warning. We fire when a non-employee lease
 * has missed-payment streak >= (threshold - 1) so the borrower gets a
 * final chance to cure before the next missed payment triggers actual
 * vehicle pull-out. Gated via lastPullOutWarningAt to avoid daily spam.
 */
async function sendLeasePullOutWarnings(
  prisma: PrismaClient,
  notifications: NotificationRepository,
  _leases: LeaseRepository,
): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  const minGapMs = 7 * dayMs;

  const rows = await prisma.leaseAgreement.findMany({
    where: { status: "ACTIVE", isEmployee: false },
    include: {
      loan: {
        include: {
          customer: true,
          product: { select: { missedPaymentPullOutCount: true } },
        },
      },
    },
  });

  let sent = 0;
  let skipped = 0;
  for (const l of rows) {
    const threshold = l.loan.product?.missedPaymentPullOutCount ?? 3;
    if (l.missedPaymentStreak < threshold - 1) {
      skipped += 1;
      continue;
    }
    if (
      l.lastPullOutWarningAt &&
      now.getTime() - l.lastPullOutWarningAt.getTime() < minGapMs
    ) {
      skipped += 1;
      continue;
    }
    const c = l.loan.customer;
    if (!c.email && !c.phone) {
      skipped += 1;
      continue;
    }
    const data = {
      customerName: `${c.firstName} ${c.lastName}`,
      loanNumber: l.loan.number,
      missedCount: String(l.missedPaymentStreak),
      threshold: String(threshold),
    };
    if (c.email) {
      await notifications.dispatch({
        event: "LEASE_PULL_OUT_WARNING",
        channel: "EMAIL",
        recipient: c.email,
        data,
        refType: "LeaseAgreement",
        refId: l.id,
        refNumber: l.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    if (c.phone) {
      await notifications.dispatch({
        event: "LEASE_PULL_OUT_WARNING",
        channel: "SMS",
        recipient: c.phone,
        data,
        refType: "LeaseAgreement",
        refId: l.id,
        refNumber: l.loan.number,
        customerId: c.id,
      });
      sent += 1;
    }
    await prisma.leaseAgreement.update({
      where: { id: l.id },
      data: { lastPullOutWarningAt: new Date() },
    });
  }
  return { sent, skipped };
}

/**
 * Placeholder for the "system" user id that job-posted entries are attributed
 * to. In a fuller system you'd seed a real `system@loan.local` user; for now
 * we use a sentinel that any post-time auditing can map to "scheduled job".
 */
function systemUserId(): string {
  return process.env.SYSTEM_USER_ID ?? "00000000-0000-0000-0000-000000000000";
}
