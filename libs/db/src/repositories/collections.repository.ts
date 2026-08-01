/**
 * Collections repository — overdue follow-up workflow.
 *
 * Owns:
 *   - Notes log (calls, SMS, visits) attached to a loan
 *   - Promise-to-pay tracking
 *   - Overdue queue listing (active loans with an unpaid installment past due)
 *   - Daily late-fee accrual (idempotent; posts via AccountingRepository)
 */

import {
  DEFAULT_LATE_FEE_POLICY,
  type LateFeePolicy,
  lateFeeFor,
  policyFromProduct,
} from "@loan/loans";
import { lateFeeAccrualEntry } from "@loan/accounting";
import type {
  CollectionNote,
  CollectionNoteType,
  LoanApplication,
  PrismaClient,
  PromiseStatus,
  PromiseToPay,
} from "@prisma/client";

import { AccountingRepository } from "./accounting.repository";

export interface NoteCreateInput {
  type: CollectionNoteType;
  body: string;
  createdById: string;
}

export interface PtpCreateInput {
  amount: number;
  promisedDate: Date;
  note?: string;
  createdById: string;
}

export class CollectionsRepository {
  private readonly accounting: AccountingRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.accounting = new AccountingRepository(prisma);
  }

  // ─── Notes ─────────────────────────────────────────────────────────

  listNotes(loanId: string): Promise<CollectionNote[]> {
    return this.prisma.collectionNote.findMany({
      where: { loanId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  addNote(loanId: string, input: NoteCreateInput): Promise<CollectionNote> {
    return this.prisma.collectionNote.create({
      data: { loanId, ...input },
    });
  }

  // ─── Promises to pay ───────────────────────────────────────────────

  listPromises(loanId: string): Promise<PromiseToPay[]> {
    return this.prisma.promiseToPay.findMany({
      where: { loanId },
      orderBy: { promisedDate: "desc" },
    });
  }

  createPromise(loanId: string, input: PtpCreateInput): Promise<PromiseToPay> {
    return this.prisma.promiseToPay.create({
      data: {
        loanId,
        amount: input.amount,
        promisedDate: input.promisedDate,
        note: input.note,
        createdById: input.createdById,
      },
    });
  }

  resolvePromise(id: string, status: PromiseStatus): Promise<PromiseToPay> {
    return this.prisma.promiseToPay.update({
      where: { id },
      data: { status, resolvedAt: new Date() },
    });
  }

  // ─── Overdue queue ─────────────────────────────────────────────────

  /**
   * Loans with at least one unpaid installment past its due date.
   * Returns the loan + a denormalized summary for the queue table.
   */
  async overdueQueue(asOf: Date = new Date()): Promise<
    Array<
      LoanApplication & {
        customerName: string;
        daysOverdue: number;
        outstanding: number;
        overdueCount: number;
      }
    >
  > {
    const rows = await this.prisma.loanApplication.findMany({
      where: {
        status: { in: ["ACTIVE", "DISBURSED", "DEFAULTED"] },
        schedule: { some: { paidInFullAt: null, dueDate: { lt: asOf } } },
      },
      include: {
        customer: { select: { firstName: true, lastName: true } },
        schedule: {
          where: { paidInFullAt: null },
          orderBy: { dueDate: "asc" },
        },
      },
    });

    const out = rows.map((l) => {
      const earliest = l.schedule[0];
      const daysOverdue = earliest
        ? Math.max(
            0,
            Math.floor(
              (asOf.getTime() - earliest.dueDate.getTime()) / 86_400_000,
            ),
          )
        : 0;
      const outstanding = l.schedule.reduce(
        (s, x) =>
          s +
          (Number(x.totalDue) -
            Number(x.principalPaid) -
            Number(x.interestPaid)),
        0,
      );
      const overdueCount = l.schedule.filter((s) => s.dueDate < asOf).length;
      const { schedule: _schedule, customer, ...rest } = l;
      return {
        ...rest,
        customerName: `${customer.firstName} ${customer.lastName}`,
        daysOverdue,
        outstanding: Math.round(outstanding * 100) / 100,
        overdueCount,
      };
    });

    out.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return out;
  }

  // ─── Late-fee accrual job ──────────────────────────────────────────

  /**
   * Daily late-fee accrual. Walks every open installment with `dueDate < asOf`,
   * computes the policy-determined late fee, and posts the *delta* vs.
   * what's already on the books for that installment+day.
   *
   * Idempotent per (scheduleId, calendar day) via postIfAbsent.
   */
  async accrueLateFees(
    asOf: Date = new Date(),
    postedById: string,
    policy: LateFeePolicy = DEFAULT_LATE_FEE_POLICY,
  ): Promise<{ posted: number; skipped: number }> {
    const installments = await this.prisma.loanSchedule.findMany({
      where: {
        paidInFullAt: null,
        dueDate: { lt: asOf },
        loan: { status: { in: ["ACTIVE", "DISBURSED"] } },
      },
      include: { loan: { include: { product: true } } },
    });

    const dayKey = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, "0")}-${String(asOf.getDate()).padStart(2, "0")}`;
    let posted = 0;
    let skipped = 0;

    for (const inst of installments) {
      const totalDue = Number(inst.totalDue);
      // Prefer per-product policy when present; fall back to caller-passed.
      const productPolicy = inst.loan.product
        ? policyFromProduct({
            lateFeeDailyRate: Number(inst.loan.product.lateFeeDailyRate),
            lateFeeCapFraction: Number(inst.loan.product.lateFeeCapFraction),
            lateFeeGraceDays: inst.loan.product.lateFeeGraceDays,
          })
        : policy;
      const targetFee = lateFeeFor(
        { dueDate: inst.dueDate, totalDue, paidInFullAt: inst.paidInFullAt },
        asOf,
        productPolicy,
      );
      if (targetFee <= 0) {
        skipped += 1;
        continue;
      }

      // Compute fee already on the books for this installment.
      const existing = await this.prisma.journalEntry.findMany({
        where: {
          source: "LATE_FEE_ACCRUAL",
          sourceRefType: "LoanScheduleLateFee",
          sourceRefId: { startsWith: `${inst.id}:` },
        },
        include: { lines: { include: { account: true } } },
      });
      const accrued = existing.reduce((sum, e) => {
        const feeLine = e.lines.find((l) => l.account.code === "4100"); // Fee Income
        return sum + (feeLine ? Number(feeLine.credit) : 0);
      }, 0);
      const delta = round2(targetFee - accrued);
      if (delta <= 0) {
        skipped += 1;
        continue;
      }

      const entry = lateFeeAccrualEntry({
        scheduleId: inst.id,
        loanNumber: inst.loan.number,
        installmentNo: inst.installmentNo,
        feeAmount: delta,
        accruedOn: asOf,
        periodKey: dayKey,
      });
      const result = await this.accounting.postIfAbsent(entry, { postedById });
      if (result.created) posted += 1;
      else skipped += 1;
    }

    return { posted, skipped };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
