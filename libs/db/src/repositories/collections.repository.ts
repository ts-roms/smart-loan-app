/**
 * Collections repository — overdue follow-up workflow.
 *
 * Owns:
 *   - Notes log (calls, SMS, visits) attached to a loan
 *   - Promise-to-pay tracking
 *   - Overdue queue listing (active loans with an unpaid installment past due)
 *   - Account ownership: which collector is working which account
 *   - Daily late-fee accrual (idempotent; posts via AccountingRepository)
 */

import {
  DEFAULT_LATE_FEE_POLICY,
  type LateFeePolicy,
  lateFeeFor,
  loanBalance,
  policyFromProduct,
} from "@loan/loans";
import { lateFeeAccrualEntry } from "@loan/accounting";
import {
  computeCollectionPriority,
  type PriorityResult,
  type RiskGrade,
} from "@loan/collections";
import type {
  CollectionNote,
  CollectionNoteType,
  LoanApplication,
  PrismaClient,
  PromiseStatus,
  PromiseToPay,
} from "@prisma/client";

import {
  feeIncomeCreditOf,
  lateFeeAccrualsBySchedule,
} from "../lib/late-fee-accruals";
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

/** The collector working an account, flattened onto a queue row. */
export interface QueueAssignee {
  collectorId: string;
  collectorName: string;
  assignedAt: Date;
  note: string | null;
}

export interface AssignInput {
  loanId: string;
  collectorId: string;
  assignedById: string;
  note?: string;
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
   *
   * `collectorId` narrows to one collector's accounts — the collector
   * dashboard's only read. Filtering here rather than in the caller
   * keeps a collector's queue from ever being assembled client-side out
   * of the full list, which would ship every borrower's delinquency to
   * someone who may only see their own.
   *
   * ─── Ordering ──────────────────────────────────────────────────────
   *
   * Sorted by §29 collection priority, NOT by days overdue.
   *
   * The old ordering was `daysOverdue` descending, which reliably put
   * the least collectible accounts at the top: the longest-failing ones.
   * A collector working it in order spent the morning on ancient small
   * balances with dead phone numbers and reached the large, recent,
   * secured, still-curable accounts last. The priority score
   * (`@loan/collections`) weighs balance, aging band, promise history,
   * contactability, customer history, risk grade and collateral
   * together, and every row carries its own factor breakdown so the
   * position is arguable rather than asserted.
   *
   * `daysOverdue` is still returned and is still exact — the UI can
   * re-sort by it, and the delinquency report reads it straight. What
   * changed is only which account is row one.
   */
  async overdueQueue(
    asOf: Date = new Date(),
    filter: { collectorId?: string; unassignedOnly?: boolean } = {},
  ): Promise<
    Array<
      LoanApplication & {
        customerName: string;
        /** Borrower's area — drives the queue's area filter. */
        customerCity: string;
        customerProvince: string | null;
        daysOverdue: number;
        outstanding: number;
        overdueCount: number;
        assignee: QueueAssignee | null;
        /** §29 score, breakdown and recommendation. */
        priority: PriorityResult;
      }
    >
  > {
    const rows = await this.prisma.loanApplication.findMany({
      where: {
        status: { in: ["ACTIVE", "DISBURSED", "DEFAULTED"] },
        schedule: { some: { paidInFullAt: null, dueDate: { lt: asOf } } },
        ...(filter.collectorId
          ? { collectionAssignment: { collectorId: filter.collectorId } }
          : {}),
        ...(filter.unassignedOnly ? { collectionAssignment: null } : {}),
      },
      include: {
        customer: {
          select: {
            firstName: true,
            lastName: true,
            city: true,
            province: true,
            // Contactability inputs — which channels exist for this
            // borrower at all.
            phone: true,
            secondaryPhone: true,
            email: true,
            // Risk grade: the most recent scorecard result, if ever run.
            creditScores: {
              select: { tier: true },
              orderBy: { computedAt: "desc" },
              take: 1,
            },
          },
        },
        schedule: {
          where: { paidInFullAt: null },
          orderBy: { dueDate: "asc" },
        },
        collectionAssignment: {
          include: { collector: { select: { name: true } } },
        },
        // Promise reliability — kept vs broken, and any open commitment.
        promisesToPay: { select: { status: true, promisedDate: true } },
        // Contact recency. Only the newest is needed: the score asks
        // "how long since anyone tried", not for the whole log.
        collectionNotes: {
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        // Collateral, at most one of the two by construction.
        vehicle: { select: { appraisedValue: true } },
        property: { select: { appraisedValue: true } },
      },
    });

    /*
     * Customer repayment history, in ONE query rather than per row.
     *
     * `notIn` the loans already on the queue so an account cannot count
     * itself as its own bad history — a DEFAULTED loan is eligible for
     * the queue, and without this exclusion it would score itself worse
     * for being the very loan being ranked.
     */
    const queueLoanIds = rows.map((l) => l.id);
    const priorLoans =
      queueLoanIds.length === 0
        ? []
        : await this.prisma.loanApplication.groupBy({
            by: ["customerId", "status"],
            where: {
              customerId: { in: rows.map((l) => l.customerId) },
              id: { notIn: queueLoanIds },
              status: { in: ["CLOSED", "DEFAULTED", "WRITTEN_OFF"] },
            },
            _count: { _all: true },
          });

    const historyByCustomer = new Map<
      string,
      { priorLoansClosed: number; priorLoansDefaulted: number }
    >();
    for (const group of priorLoans) {
      const acc = historyByCustomer.get(group.customerId) ?? {
        priorLoansClosed: 0,
        priorLoansDefaulted: 0,
      };
      if (group.status === "CLOSED") acc.priorLoansClosed += group._count._all;
      else acc.priorLoansDefaulted += group._count._all;
      historyByCustomer.set(group.customerId, acc);
    }

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
      /*
       * Balance via @loan/loans rather than a reduce written here.
       * `loanBalance` over the open instalments is the same arithmetic
       * this used to inline, minus the risk of the queue and the rest of
       * the system disagreeing about what a borrower owes.
       *
       * Decimal columns are coerced at this boundary, as elsewhere in
       * the repositories — the lib takes numbers, not Prisma types.
       */
      const outstanding = loanBalance(
        l.schedule.map((s) => ({
          principalDue: Number(s.principalDue),
          interestDue: Number(s.interestDue),
          totalDue: Number(s.totalDue),
          principalPaid: Number(s.principalPaid),
          interestPaid: Number(s.interestPaid),
          paidInFullAt: s.paidInFullAt,
        })),
      ).outstanding;
      const overdueCount = l.schedule.filter((s) => s.dueDate < asOf).length;
      const {
        schedule: _schedule,
        customer,
        collectionAssignment,
        promisesToPay,
        collectionNotes,
        vehicle,
        property,
        ...rest
      } = l;

      const collateral = vehicle?.appraisedValue ?? property?.appraisedValue;

      const priority = computeCollectionPriority({
        asOf,
        loanStatus: l.status,
        daysOverdue,
        outstanding,
        riskGrade: (customer.creditScores[0]?.tier as RiskGrade) ?? null,
        promises: promisesToPay.map((p) => ({
          status: p.status,
          promisedDate: p.promisedDate,
        })),
        contact: {
          phone: customer.phone,
          secondaryPhone: customer.secondaryPhone,
          email: customer.email,
          lastContactAt: collectionNotes[0]?.createdAt ?? null,
        },
        history: historyByCustomer.get(l.customerId) ?? {
          priorLoansClosed: 0,
          priorLoansDefaulted: 0,
        },
        collateralValue: collateral === undefined ? null : Number(collateral),
      });

      return {
        ...rest,
        customerName: `${customer.firstName} ${customer.lastName}`,
        customerCity: customer.city,
        customerProvince: customer.province,
        daysOverdue,
        outstanding: Math.round(outstanding * 100) / 100,
        overdueCount,
        assignee: collectionAssignment
          ? {
              collectorId: collectionAssignment.collectorId,
              collectorName: collectionAssignment.collector.name,
              assignedAt: collectionAssignment.assignedAt,
              note: collectionAssignment.note,
            }
          : null,
        priority,
      };
    });

    // Priority first; days overdue only to break exact ties, so the
    // order stays deterministic across requests.
    out.sort(
      (a, b) =>
        b.priority.score - a.priority.score || b.daysOverdue - a.daysOverdue,
    );
    return out;
  }

  // ─── Account ownership ─────────────────────────────────────────────

  /**
   * Give an account to a collector, or move it to a different one.
   *
   * Upsert rather than create: `loanId` is unique, so reassignment is
   * the same operation as first assignment. `assignedAt` is refreshed on
   * the move — "held since" means since this collector got it, not since
   * the account was first handed to anyone.
   */
  async assign(input: AssignInput) {
    return this.prisma.collectionAssignment.upsert({
      where: { loanId: input.loanId },
      create: {
        loanId: input.loanId,
        collectorId: input.collectorId,
        assignedById: input.assignedById,
        note: input.note ?? null,
      },
      update: {
        collectorId: input.collectorId,
        assignedById: input.assignedById,
        assignedAt: new Date(),
        note: input.note ?? null,
      },
      include: { collector: { select: { id: true, name: true } } },
    });
  }

  /**
   * Hand a batch of accounts to one collector — the "everything overdue
   * in Bulacan goes to Ana" operation behind the queue's area filter.
   *
   * Ids that match no loan are reported back rather than silently
   * dropped OR failing the batch: the supervisor selected rows from a
   * live queue, and a loan deleted in between shouldn't void the other
   * forty-nine assignments. All writes commit in one transaction, so a
   * mid-batch failure can't leave half an area assigned.
   */
  async assignBulk(input: {
    loanIds: string[];
    collectorId: string;
    assignedById: string;
    note?: string;
  }): Promise<{ assigned: number; missing: string[] }> {
    const found = await this.prisma.loanApplication.findMany({
      where: { id: { in: input.loanIds } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((l) => l.id));
    const missing = input.loanIds.filter((id) => !foundIds.has(id));

    await this.prisma.$transaction(
      [...foundIds].map((loanId) =>
        this.prisma.collectionAssignment.upsert({
          where: { loanId },
          create: {
            loanId,
            collectorId: input.collectorId,
            assignedById: input.assignedById,
            note: input.note ?? null,
          },
          update: {
            collectorId: input.collectorId,
            assignedById: input.assignedById,
            assignedAt: new Date(),
            note: input.note ?? null,
          },
        }),
      ),
    );
    return { assigned: foundIds.size, missing };
  }

  /**
   * Return an account to the unassigned pool. Idempotent — unassigning
   * something already unassigned is a no-op rather than an error, so a
   * double-click can't 500.
   */
  async unassign(loanId: string): Promise<boolean> {
    const { count } = await this.prisma.collectionAssignment.deleteMany({
      where: { loanId },
    });
    return count > 0;
  }

  /**
   * Per-collector counts for the supervisor's view: how loaded is
   * everyone, right now.
   *
   * Counts assignments, NOT currently-delinquent assignments — an
   * account that cured keeps its owner (see the model comment), so this
   * answers "how many accounts is this person carrying", which is the
   * question a supervisor about to hand out more work is asking.
   */
  async workloadByCollector(): Promise<
    Array<{ collectorId: string; collectorName: string; accounts: number }>
  > {
    const grouped = await this.prisma.collectionAssignment.groupBy({
      by: ["collectorId"],
      _count: { _all: true },
    });
    if (grouped.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.collectorId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));
    return grouped
      .map((g) => ({
        collectorId: g.collectorId,
        collectorName: nameById.get(g.collectorId) ?? "(deleted user)",
        accounts: g._count._all,
      }))
      .sort((a, b) => b.accounts - a.accounts);
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

    /*
     * Pass 1 — the policy arithmetic, which needs no database at all.
     *
     * An instalment whose target fee is zero is skipped here and never
     * reaches the accrual lookup, exactly as before: the old loop hit
     * `continue` before issuing its query.
     */
    const pending: Array<{
      inst: (typeof installments)[number];
      targetFee: number;
    }> = [];
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

      pending.push({ inst, targetFee });
    }

    /*
     * One batched read for the whole night instead of one per instalment —
     * finding F1. Before this, the loop body below ran a `JournalEntry`
     * prefix query 8,472 times a night at measured volume.
     *
     * This is a pre-read used to compute the delta to post, NOT a guard.
     * `postIfAbsent` below still attempts the insert and still lets the
     * unique index on (source, sourceRefType, sourceRefId) arbitrate against
     * a concurrent poster. Reading further ahead of the write makes the read
     * no weaker than it was, because it was never what made the post
     * idempotent — the same argument `postIfAbsent` makes about its own
     * internal lookup.
     */
    const accrualsBySchedule = await lateFeeAccrualsBySchedule(
      this.prisma,
      pending.map((p) => p.inst.id),
    );

    // Pass 2 — post the delta, in the same order, with the same arithmetic.
    for (const { inst, targetFee } of pending) {
      // Fee already on the books for this installment (Fee Income, 4100).
      const accrued = feeIncomeCreditOf(accrualsBySchedule.get(inst.id) ?? []);
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
