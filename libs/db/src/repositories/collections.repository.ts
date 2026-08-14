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
import {
  type Page,
  type PageParams,
  type PagingBounds,
  resolvePaging,
  toPage,
} from "../lib/pagination";
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

export interface OverdueQueueFilter {
  /** Narrow to one collector's own book. */
  collectorId?: string;
  /** Only accounts nobody holds — the hand-out pool. */
  unassignedOnly?: boolean;
  /**
   * Borrower's area.
   *
   * Applied in SQL rather than by the caller, because the queue is now
   * served a page at a time and filtering a page is not filtering the
   * book — a collector narrowing to "Cebu" must get every Cebu account,
   * not the Cebu ones that happened to land on page 1. Matching is
   * case-insensitive EQUALITY, not substring, matching the exportable
   * delinquency report it shares its derivation with: these values
   * arrive typed rather than picked from a list, and "Rizal" as a
   * substring would also pull every city with Rizal in its name.
   */
  province?: string;
  city?: string;
}

/** One ranked account on the queue. */
export type OverdueQueueRow = LoanApplication & {
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
};

/**
 * Page bounds for the queue.
 *
 * Smaller than the 200/500 the customer and loan lists use. A collector
 * works this list top-down by hand and does not read 200 accounts in a
 * sitting; the point of the ordering is that the first screen is the
 * right screen.
 */
const QUEUE_PAGING: PagingBounds = { defaultPageSize: 50, maxPageSize: 200 };

/**
 * Ids per `IN (...)` list in the repayment-history lookup.
 *
 * Postgres caps a prepared statement at 32,767 bind variables. Well
 * under it, because the cost of an extra round trip here is nothing next
 * to the cost of the query failing outright — which is what it did
 * before this bound existed. See the lookup for the whole story.
 */
const HISTORY_ID_CHUNK = 10_000;

/** The area half of the queue's `where`, or nothing when unfiltered. */
function areaWhere(filter: OverdueQueueFilter) {
  const province = filter.province?.trim();
  const city = filter.city?.trim();
  if (!province && !city) return {};
  return {
    customer: {
      ...(province
        ? { province: { equals: province, mode: "insensitive" as const } }
        : {}),
      ...(city ? { city: { equals: city, mode: "insensitive" as const } } : {}),
    },
  };
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
    filter: OverdueQueueFilter = {},
  ): Promise<OverdueQueueRow[]> {
    /*
     * Fetched whole, deliberately — chunking was MEASURED AND REJECTED
     * here, unlike in the aging and roll-rate reads.
     *
     * Every matching loan has to be resident at once: the §29 ranking
     * compares each account against every other, so the fold retains
     * everything it is given. Walking the same rows in chunks therefore
     * moves the same bytes into the same array and changes nothing about
     * the peak — measured on the scratch book (22,136 overdue accounts,
     * 94,714 open instalments) at 328 MB retained either way, for 7 round
     * trips whole against 22 chunked and ~19% more wall clock.
     * `forEachBookChunk` pays for itself only where the accumulator
     * discards, which is why the other two reads use it and this one
     * does not.
     *
     * What genuinely bounds this read is a pre-filter that already
     * existed and is already indexed: `status IN (ACTIVE, DISBURSED,
     * DEFAULTED)` with `schedule some (paidInFullAt IS NULL AND dueDate <
     * asOf)`. Only loans actually past due, served by
     * LoanSchedule(paidInFullAt, dueDate) from
     * 20260813090000_query_plan_indexes. The queue is tens of thousands
     * of accounts, not the 120,000-loan book — which is what makes
     * scoring all of it affordable, and what `overdueQueuePage` relies on.
     *
     * The unbounded thing this read really had was its RESPONSE: 84 MB of
     * JSON for the measured queue, on an on-demand endpoint. That is
     * bounded now — see `overdueQueuePage`.
     */
    const rows = await this.prisma.loanApplication.findMany({
      where: {
        status: { in: ["ACTIVE", "DISBURSED", "DEFAULTED"] },
        schedule: { some: { paidInFullAt: null, dueDate: { lt: asOf } } },
        ...(filter.collectorId
          ? { collectionAssignment: { collectorId: filter.collectorId } }
          : {}),
        ...(filter.unassignedOnly ? { collectionAssignment: null } : {}),
        ...areaWhere(filter),
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
      // Deterministic, so two requests a second apart return the same
      // order for accounts whose scores tie. The final ordering is the
      // §29 sort below; this only makes the tie-break stable.
      orderBy: { id: "asc" },
    });

    /*
     * Customer repayment history, grouped in SQL rather than per row.
     *
     * ─── Why this is chunked, and why the exclusion became a subtraction
     *
     * This query used to name every queue loan twice: once as
     * `customerId IN (...)` and once as `id NOT IN (queueLoanIds)`. Each
     * id is a bind variable and Postgres refuses a prepared statement
     * with more than 32,767 of them, so on a book with more than ~16,000
     * overdue accounts the whole queue failed outright with P2035 —
     * "too many bind variables ... received 44276" at the volume this
     * was measured on. Not slow: broken, and only above a threshold no
     * test had ever crossed.
     *
     * Both halves are fixed here.
     *
     * The `notIn` is gone entirely, replaced by an exact subtraction.
     * Its job was to stop an account counting itself as its own bad
     * history — a DEFAULTED loan is eligible for the queue, and without
     * the exclusion it would score itself worse for being the very loan
     * being ranked. But the only status a queue loan and this filter can
     * share is DEFAULTED: the queue is ACTIVE/DISBURSED/DEFAULTED and
     * the filter is CLOSED/DEFAULTED/WRITTEN_OFF. So counting everything
     * and then subtracting each customer's own DEFAULTED queue loans is
     * the same number, and costs no bind variables at all.
     *
     * The `customerId IN (...)` list is chunked. Distinct customers, so
     * a borrower with several overdue accounts is named once.
     */
    const queueCustomerIds = [...new Set(rows.map((l) => l.customerId))];

    const historyByCustomer = new Map<
      string,
      { priorLoansClosed: number; priorLoansDefaulted: number }
    >();
    const historyOf = (customerId: string) => {
      let acc = historyByCustomer.get(customerId);
      if (!acc) {
        acc = { priorLoansClosed: 0, priorLoansDefaulted: 0 };
        historyByCustomer.set(customerId, acc);
      }
      return acc;
    };

    for (let i = 0; i < queueCustomerIds.length; i += HISTORY_ID_CHUNK) {
      const batch = queueCustomerIds.slice(i, i + HISTORY_ID_CHUNK);
      const groups = await this.prisma.loanApplication.groupBy({
        by: ["customerId", "status"],
        where: {
          customerId: { in: batch },
          status: { in: ["CLOSED", "DEFAULTED", "WRITTEN_OFF"] },
        },
        _count: { _all: true },
      });
      for (const group of groups) {
        const acc = historyOf(group.customerId);
        if (group.status === "CLOSED") {
          acc.priorLoansClosed += group._count._all;
        } else {
          acc.priorLoansDefaulted += group._count._all;
        }
      }
    }

    // The subtraction that replaces `notIn`: a DEFAULTED loan on the
    // queue counted itself above, and must not.
    for (const l of rows) {
      if (l.status === "DEFAULTED") {
        historyOf(l.customerId).priorLoansDefaulted -= 1;
      }
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

  /**
   * One page of the queue, in the queue's own global order.
   *
   * ─── Why this is a slice and not a `take`/`skip` ────────────────────
   *
   * The ordering key does not exist in the database. The §29 score is
   * computed in JavaScript (`@loan/collections`) from seven weighted
   * factors drawn from six relations — exposure, aging band, promise
   * outcomes, contact channels and recency, the borrower's history
   * across their whole book, scorecard tier, collateral. Postgres cannot
   * order by it, so `ORDER BY score LIMIT 50 OFFSET 50` is not a query
   * that can be written.
   *
   * Three ways out were considered. This is the one taken, and the two
   * that were not, with the reason:
   *
   * 1. REJECTED — page over a stable SQL ordering and score within the
   *    page. This is the cheap fix and it is the wrong one. Page 2 would
   *    hold the 51st-to-100th loans by loan id, re-ranked among
   *    themselves, and the highest-priority account in the book could sit
   *    on page 7 with a rank of 1. The screen would look correct — sorted
   *    descending, scores attached — while telling a collector to call
   *    the wrong borrower. §29 exists precisely because working the queue
   *    in the wrong order costs recoveries, and a silently local ranking
   *    reintroduces that failure in a form nobody can see. Not done.
   *
   * 2. NOT DONE IN THIS BATCH — push the score into SQL so the database
   *    can order and page it. This is the only thing that makes the
   *    ranking pageable in the strict sense, and it is a real piece of
   *    work: the seven factors, the aging bands, the ₱500,000 exposure
   *    ceiling, the suppression rules and the neutral-0.5 defaults would
   *    all have to be expressed as SQL, and would then exist in two
   *    places that must agree forever. Two implementations of a scoring
   *    policy drift, and the failure mode when they do is a queue that
   *    ranks differently depending on which endpoint you asked — with no
   *    error. It needs its own change, its own tests, and a decision
   *    about where the policy lives. What it needs precisely is recorded
   *    in the F4 report.
   *
   * 3. TAKEN — score the whole eligible set, rank it globally, and serve
   *    a window of the result. The ranking a collector sees is
   *    unchanged: row 1 is the same account it was before this change,
   *    and so is row 400. What is bounded is the RESPONSE, which was the
   *    other half of the §58 finding ("Large API Responses"), plus the
   *    peak hydration in `overdueQueue` itself.
   *
   * This is affordable because the set being scored is small, and it is
   * small because of a pre-filter that already existed and is already
   * indexed — only loans with an unpaid instalment actually past due.
   * See the note on the scan in `overdueQueue`.
   *
   * ─── Offset, and why it fits here ──────────────────────────────────
   *
   * Offset over a materialized in-memory list, so the objection to deep
   * offsets does not apply: nothing is re-scanned per page, the list is
   * already ranked and in hand, and the slice is O(1). A cursor would
   * need a stable database-orderable key, which is the one thing this
   * ordering does not have.
   *
   * ─── Why the area filter is applied here and not in the query ──────
   *
   * `overdueQueue` can push an area filter into SQL and does. This method
   * deliberately does not use that, and scans the caller's whole SCOPE
   * (their own book, or the unassigned pool) instead, because it has to
   * return `areas` as well — the values the filter control offers.
   *
   * Those have to be derived from the unfiltered scope. A dropdown built
   * from the filtered set collapses to the one area already chosen, and a
   * dropdown built from the current page offers only the areas that
   * happened to land on it while silently hiding the rest of a
   * collector's book. Deriving both from one scan costs nothing extra:
   * the whole scope is scanned regardless, because the ranking demands
   * it, so filtering the ranked list in memory adds no query.
   */
  async overdueQueuePage(
    asOf: Date = new Date(),
    filter: OverdueQueueFilter = {},
    paging: PageParams = {},
  ): Promise<
    Page<OverdueQueueRow> & { areas: { provinces: string[]; cities: string[] } }
  > {
    const { province, city, ...scope } = filter;
    const ranked = await this.overdueQueue(asOf, scope);

    const provinces = new Set<string>();
    const cities = new Set<string>();
    for (const r of ranked) {
      if (r.customerProvince) provinces.add(r.customerProvince);
      if (r.customerCity) cities.add(r.customerCity);
    }

    const wantProvince = province?.trim().toLowerCase();
    const wantCity = city?.trim().toLowerCase();
    // Same case-insensitive equality as the delinquency export, so the
    // screen and the CSV can never disagree about who is in an area.
    const matching = ranked.filter(
      (r) =>
        (!wantProvince ||
          (r.customerProvince ?? "").toLowerCase() === wantProvince) &&
        (!wantCity || r.customerCity.toLowerCase() === wantCity),
    );

    const resolved = resolvePaging(paging, QUEUE_PAGING);
    return {
      ...toPage(
        matching.slice(resolved.skip, resolved.skip + resolved.take),
        matching.length,
        resolved,
      ),
      areas: {
        provinces: [...provinces].sort((a, b) => a.localeCompare(b)),
        cities: [...cities].sort((a, b) => a.localeCompare(b)),
      },
    };
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
