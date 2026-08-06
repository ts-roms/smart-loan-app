import {
  allocatePayment,
  loanDisbursementEntry,
  loanPaymentEntry,
  preTerminationFeeEntry,
} from "@loan/accounting";
import {
  type LoanBalance,
  type LoanProductConfig,
  balanceFromTotals,
  computeAmortizationFor,
  computeFees,
  daysBetweenInstallments,
  effectiveMaxLtv,
  installmentCount,
  rateForTier,
  validateLoanApplication,
} from "@loan/loans";
import type {
  CollateralStatus,
  CreditTier,
  LoanApplication,
  LoanPayment,
  LoanProduct,
  LoanStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import { AccountingRepository } from "./accounting.repository";
import {
  idOrNumberWhere,
  nextPropertyNumber,
  nextVehicleNumber,
} from "../lib/reference-numbers";
import {
  resolvePaging,
  toPage,
  type Page,
  type PageParams,
} from "../lib/pagination";
import { contains, tokenizedWhere } from "../lib/search";

/**
 * Filters for the loan list. All optional — an empty filter is the
 * historical behaviour (200 most recent).
 */
export interface LoanListFilter extends PageParams {
  /**
   * Free text over the loan number and the borrower's name / reference.
   * Tokenized, so "cruz salary" and "juan LN-2026" both work — see
   * lib/search.ts.
   */
  q?: string;
  status?: LoanStatus;
  productCode?: string;
  /**
   * Scope to one borrower. Drives the loan history on a customer's
   * profile — "what has this person borrowed before" is the question an
   * officer asks before lending again, and until now the only way to
   * answer it was to search the global list by their name and hope the
   * spelling matched.
   */
  customerId?: string;
}

/** Slim borrower projection carried on each list row. */
export interface LoanListCustomer {
  id: string;
  number: string;
  firstName: string;
  lastName: string;
}

export type LoanListRow = LoanApplication & {
  customer: LoanListCustomer;
  /**
   * Where the loan actually stands. Null before disbursement — there are
   * no instalments yet, and reporting a zero balance on an approved loan
   * would read as "nothing to pay" rather than "nothing scheduled yet".
   */
  balance: LoanBalance | null;
};

/**
 * 200 by default to match the historical uncapped-feeling behaviour the
 * dashboard still relies on. The loans table asks for 25.
 */
const LOAN_PAGING = { defaultPageSize: 200, maxPageSize: 500 };

export interface VehicleInput {
  kind: "CAR" | "MOTORCYCLE";
  make: string;
  model: string;
  year: number;
  plateNumber?: string;
  chassisNumber?: string;
  engineNumber?: string;
  color?: string;
  appraisedValue: number;
  notes?: string;
}

export interface PropertyInput {
  propertyType: string;
  address: string;
  city: string;
  province?: string;
  postalCode?: string;
  titleNumber?: string;
  taxDecNumber?: string;
  areaSqm?: number;
  appraisedValue: number;
  notes?: string;
}

export interface LoanApplyInput {
  customerId: string;
  /** Product catalog code (e.g. "SALARY"). FK to LoanProduct.code. */
  productCode: string;
  principal: number;
  termMonths: number;
  /**
   * Annual rate the applicant requested. Ignored when the product has
   * `rateByTier` configured — that takes precedence.
   */
  annualInterestRate: number;
  purpose?: string;
  creditScoreAtApply: number | null;
  tierAtApply: CreditTier | null;
  submittedById: string;
  vehicle?: VehicleInput;
  property?: PropertyInput;
  /** Optional live-capture selfie taken at apply, used for face-match + fraud. */
  applicationSelfieUrl?: string;
  /**
   * Snapshot of the product's KYC declaration questionnaire + answers,
   * built by the caller with @loan/kyc's snapshotDeclarations. The repo
   * stores it verbatim — validation is the service's job, since only it
   * knows whether partial answers are acceptable for the flow at hand.
   */
  kycDeclarations?: unknown;
  /** Override initial status (used by decisioning engine). */
  initialStatus?: "SUBMITTED" | "APPROVED" | "REJECTED";
  /** Reason recorded with the decision when not SUBMITTED. */
  initialDecisionReason?: string;
  /** If this loan replaces an older one, the original's id. */
  restructuredFromId?: string;
  /**
   * If this loan RENEWS an older one, that loan's id.
   *
   * Distinct from `restructuredFromId` because the two say opposite
   * things about the borrower — see the schema comment. Practically, it
   * also exempts the named loan from the one-live-loan guard, since a
   * renewal exists precisely to replace something still open.
   */
  renewedFromId?: string;
}

export interface LoanDecideInput {
  status: "APPROVED" | "REJECTED";
  reason?: string;
  decidedById: string;
}

export interface RecordPaymentInput {
  amount: number;
  paidOn: Date;
  reference?: string;
  recordedById: string;
}

export interface BulkPaymentRow {
  /** Either the human-readable loan number or the loan id; one must be present. */
  loanNumber?: string;
  loanId?: string;
  amount: number;
  paidOn?: Date;
  reference?: string;
}

export interface BulkPaymentRowResult {
  index: number;
  loanNumber: string;
  loanId: string | null;
  ok: boolean;
  paymentId?: string;
  error?: string;
}

export interface CloseEarlyInput {
  closedById: string;
  /** Payment that settles the remaining principal + pre-term fee. */
  settlementAmount: number;
  reference?: string;
}

export interface RestructureInput {
  /** Officer doing the restructure. */
  restructuredById: string;
  /** Product code for the new loan; may differ from the original. */
  productCode: string;
  /** New principal. Typically = remaining principal + optional top-up. */
  principal: number;
  termMonths: number;
  annualInterestRate: number;
  purpose?: string;
}

export interface WriteOffInput {
  /** Officer doing the write-off. */
  writtenOffById: string;
  reason: string;
}

/**
 * Loan lifecycle owner. Each transition runs in a single Prisma transaction
 * so the loan + schedule + payment + journal-entry rows stay consistent.
 *
 * The product catalog is dynamic — every transition reads the relevant
 * `LoanProduct` row to apply that product's fees, late-fee policy,
 * interest method, payment frequency, and pre-termination fee.
 */
/**
 * Statuses that can receive a payment: money has actually left the
 * lender, so there is a receivable to settle.
 *
 * CLOSED and WRITTEN_OFF are in deliberately. A payment on a settled
 * loan is booked to Customer Advances, and recovery on a written-off
 * account is a real event — refusing either would lose money the
 * borrower actually sent.
 *
 * Everything else is out because no funds were released: DRAFT,
 * SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, CANCELLED. So is
 * RESTRUCTURED — that loan was replaced, and its balance now lives on
 * the successor, so a payment here would be credited against the wrong
 * receivable.
 */
const PAYABLE_STATUSES: ReadonlySet<LoanStatus> = new Set<LoanStatus>([
  "DISBURSED",
  "ACTIVE",
  "DEFAULTED",
  "CLOSED",
  "WRITTEN_OFF",
]);

/**
 * A payment was recorded against a loan that cannot take one.
 *
 * Named so the HTTP layer can answer 409 rather than letting it surface
 * as a 500 — the request was well-formed, the loan's state forbids it.
 */
/**
 * The customer already has a loan open.
 *
 * Thrown from inside `apply`'s transaction rather than checked before
 * it, for two reasons. First, there are two application paths — the
 * officer console and the borrower portal — and only the repository is
 * common to both; a guard in one service is a guard the other route
 * walks straight past, which is exactly what happened. Second, a
 * pre-flight check outside the transaction loses to a double-submit:
 * two requests both read "no live loans" and both insert.
 *
 * Carries the offending loans so the HTTP layer can name them instead
 * of just refusing.
 */
export class CustomerHasLiveLoanError extends Error {
  readonly code = "HAS_LIVE_LOAN" as const;
  constructor(
    readonly liveLoans: Array<{
      id: string;
      number: string;
      status: LoanStatus;
      principal: number;
    }>,
  ) {
    super(
      liveLoans.length === 1
        ? `This customer already has loan ${liveLoans[0]!.number} (${liveLoans[0]!.status}). Settle or close it before applying again.`
        : `This customer already has ${liveLoans.length} open loans (${liveLoans.map((l) => l.number).join(", ")}). Settle or close them before applying again.`,
    );
    this.name = "CustomerHasLiveLoanError";
  }
}

/**
 * States that block a new application.
 *
 * Money out (DISBURSED / ACTIVE / DEFAULTED) and money promised
 * (SUBMITTED / UNDER_REVIEW / APPROVED). An APPROVED-but-undisbursed
 * loan counts: the funds are already committed, and it was precisely
 * this case that slipped through when the check lived in one service.
 *
 * Terminal states — CLOSED, REJECTED, CANCELLED, WRITTEN_OFF — do not
 * block. A settled borrower coming back is the ordinary case.
 */
export const LIVE_LOAN_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "DISBURSED",
  "ACTIVE",
  "DEFAULTED",
] as const satisfies readonly LoanStatus[];

export class LoanNotPayableError extends Error {
  readonly code = "LOAN_NOT_PAYABLE" as const;
  constructor(
    readonly loanNumber: string,
    readonly status: LoanStatus,
  ) {
    super(
      `Loan ${loanNumber} is ${status} and cannot receive a payment — ` +
        `funds have not been disbursed.`,
    );
    this.name = "LoanNotPayableError";
  }
}

export class LoanRepository {
  private readonly accounting: AccountingRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.accounting = new AccountingRepository(prisma);
  }

  /**
   * Filtering happens in Postgres, not in the client. The list is capped,
   * so a client-side filter would only ever search the newest page and
   * quietly miss the older loan the operator is looking for.
   *
   * Rows carry a slim borrower projection — four columns, not the whole
   * customer record. Without it, searching by borrower name would match
   * rows the operator can't see the reason for; with the whole record it
   * would ship every borrower's income and government ID to a screen
   * that shows neither.
   */
  async list(filter: LoanListFilter = {}): Promise<Page<LoanListRow>> {
    const paging = resolvePaging(filter, LOAN_PAGING);
    const where = {
      status: filter.status,
      productCode: filter.productCode,
      customerId: filter.customerId,
      ...(tokenizedWhere(filter.q, (token) => [
        { number: contains(token) },
        { customer: { number: contains(token) } },
        { customer: { firstName: contains(token) } },
        { customer: { middleName: contains(token) } },
        { customer: { lastName: contains(token) } },
      ]) ?? {}),
    };

    // One transaction so the count and the rows describe the same
    // snapshot. Run separately, a loan submitted between the two makes
    // the footer claim a total the table can't page to.
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.loanApplication.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        skip: paging.skip,
        take: paging.take,
        include: {
          customer: {
            select: { id: true, number: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.loanApplication.count({ where }),
    ]);

    const balances = await this.balancesFor(rows.map((r) => r.id));
    return toPage(
      rows.map((row) => ({ ...row, balance: balances.get(row.id) ?? null })),
      total,
      paging,
    );
  }

  /**
   * Current balance for each of the given loans, keyed by loan id.
   *
   * One `groupBy` rather than a schedule `include`: a 360-month loan is
   * 360 rows, and a page of 200 such loans would ship and fold 72,000
   * rows to render one number each. Postgres sums them instead and we
   * get one row per loan back.
   *
   * `_count: { paidInFullAt: true }` counts non-null values, which is
   * exactly the settled-instalment count — the repository sets that
   * column only once principal AND interest are both covered.
   *
   * Loans with no schedule are absent from the result rather than
   * present with zeros, so callers can tell "not disbursed" from
   * "nothing left to pay".
   */
  async balancesFor(loanIds: string[]): Promise<Map<string, LoanBalance>> {
    if (loanIds.length === 0) return new Map();
    const groups = await this.prisma.loanSchedule.groupBy({
      by: ["loanId"],
      where: { loanId: { in: loanIds } },
      _sum: {
        totalDue: true,
        principalDue: true,
        principalPaid: true,
        interestPaid: true,
      },
      _count: { _all: true, paidInFullAt: true },
    });

    return new Map(
      groups.map((g) => {
        const principalPaid = Number(g._sum.principalPaid ?? 0);
        return [
          g.loanId,
          balanceFromTotals({
            scheduled: Number(g._sum.totalDue ?? 0),
            paid: principalPaid + Number(g._sum.interestPaid ?? 0),
            principalScheduled: Number(g._sum.principalDue ?? 0),
            principalPaid,
            paidInstallments: g._count.paidInFullAt,
            totalInstallments: g._count._all,
          }),
        ];
      }),
    );
  }

  findById(id: string) {
    return this.prisma.loanApplication.findUnique({
      where: { id },
      include: {
        schedule: { orderBy: { installmentNo: "asc" } },
        payments: { orderBy: { paidOn: "desc" } },
        customer: true,
        vehicle: true,
        property: true,
        product: true,
      },
    });
  }

  /**
   * Resolve a loan by either its UUID or its "LN-2026-..." number — the
   * canonical API now uses the number on URL paths, but legacy callers
   * passing UUIDs are still served from this same lookup.
   */
  findByIdOrNumber(idOrNumber: string) {
    return this.prisma.loanApplication.findFirst({
      where: idOrNumberWhere(idOrNumber),
      include: {
        schedule: { orderBy: { installmentNo: "asc" } },
        payments: { orderBy: { paidOn: "desc" } },
        customer: true,
        vehicle: true,
        property: true,
        product: true,
      },
    });
  }

  async apply(input: LoanApplyInput): Promise<LoanApplication> {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.loanProduct.findUnique({
        where: { code: input.productCode },
      });
      if (!product || !product.active) {
        throw new Error(`Loan product ${input.productCode} is not available.`);
      }

      // Resolve the effective rate. If the product has tier-based pricing
      // and the customer has a tier, that wins over the requested rate.
      let rate = input.annualInterestRate;
      const cfg = toConfig(product);
      if (cfg.rateByTier && input.tierAtApply) {
        const tierRate = rateForTier(
          { ...cfg, defaultRate: Number(product.defaultRate) },
          input.tierAtApply,
        );
        if (tierRate == null && cfg.rateByTier[input.tierAtApply] === null) {
          throw new Error(
            `Product ${product.code} is not available for tier ${input.tierAtApply}.`,
          );
        }
        if (tierRate != null) rate = tierRate;
      }

      const collateralValue =
        input.vehicle?.appraisedValue ?? input.property?.appraisedValue;
      const issues = validateLoanApplication(cfg, {
        principal: input.principal,
        termMonths: input.termMonths,
        annualInterestRate: rate,
        collateralAppraisedValue: collateralValue,
        tierAtApply: input.tierAtApply ?? null,
      });
      if (issues.length > 0) {
        const err = new Error(issues.map((i) => i.message).join(" "));
        (err as Error & { issues?: unknown }).issues = issues;
        throw err;
      }

      if (product.collateralKind === "VEHICLE" && !input.vehicle) {
        throw new Error(`${product.code} requires a vehicle.`);
      }
      if (product.collateralKind === "PROPERTY" && !input.property) {
        throw new Error(`${product.code} requires a property.`);
      }

      let vehicleId: string | undefined;
      let propertyId: string | undefined;
      if (product.collateralKind === "VEHICLE" && input.vehicle) {
        // Allocate the human-readable reference number inside the same tx
        // so concurrent loan applications can't both grab seq=N+1.
        const vehicleNumber = await nextVehicleNumber(
          tx as unknown as PrismaClient,
        );
        const v = await tx.vehicle.create({
          data: {
            number: vehicleNumber,
            kind: input.vehicle.kind,
            make: input.vehicle.make,
            model: input.vehicle.model,
            year: input.vehicle.year,
            plateNumber: input.vehicle.plateNumber,
            chassisNumber: input.vehicle.chassisNumber,
            engineNumber: input.vehicle.engineNumber,
            color: input.vehicle.color,
            appraisedValue: input.vehicle.appraisedValue,
            notes: input.vehicle.notes,
            status: "PROPOSED" satisfies CollateralStatus,
          },
        });
        vehicleId = v.id;
      } else if (product.collateralKind === "PROPERTY" && input.property) {
        const propertyNumber = await nextPropertyNumber(
          tx as unknown as PrismaClient,
        );
        const p = await tx.property.create({
          data: {
            number: propertyNumber,
            propertyType: input.property.propertyType,
            address: input.property.address,
            city: input.property.city,
            province: input.property.province,
            postalCode: input.property.postalCode,
            titleNumber: input.property.titleNumber,
            taxDecNumber: input.property.taxDecNumber,
            areaSqm: input.property.areaSqm,
            appraisedValue: input.property.appraisedValue,
            notes: input.property.notes,
            status: "PROPOSED" satisfies CollateralStatus,
          },
        });
        propertyId = p.id;
      }

      /*
       * One live loan at a time — enforced HERE, inside the
       * transaction, so neither application path can miss it and two
       * simultaneous submissions can't both slip through a pre-check.
       *
       * `renewedFromId` is the one legitimate way past: a renewal
       * exists precisely to replace a live loan, and the loan it names
       * is allowed to be open. Everything else the customer holds still
       * blocks.
       */
      const blocking = await tx.loanApplication.findMany({
        where: {
          customerId: input.customerId,
          status: { in: [...LIVE_LOAN_STATUSES] },
          ...(input.renewedFromId ? { id: { not: input.renewedFromId } } : {}),
          // A restructure replaces its original, so the original must
          // not block its replacement either.
          ...(input.restructuredFromId
            ? { id: { not: input.restructuredFromId } }
            : {}),
        },
        select: { id: true, number: true, status: true, principal: true },
        orderBy: { submittedAt: "desc" },
      });
      if (blocking.length > 0) {
        throw new CustomerHasLiveLoanError(
          blocking.map((l) => ({
            id: l.id,
            number: l.number,
            status: l.status,
            principal: Number(l.principal),
          })),
        );
      }

      const number = await this.nextApplicationNumber(tx);
      const initialStatus = (input.initialStatus ?? "SUBMITTED") as LoanStatus;

      // Repeat-loan flag. True when this customer already has at
      // least one CLOSED loan and no DEFAULTED / WRITTEN_OFF in history.
      // Restructures keep their `restructuredFromId` link and don't count
      // here — they're a continuation of an existing line, not a new one.
      const priorLoans = await tx.loanApplication.count({
        where: { customerId: input.customerId, status: "CLOSED" },
      });
      const badPriorLoans = await tx.loanApplication.count({
        where: {
          customerId: input.customerId,
          status: { in: ["DEFAULTED", "WRITTEN_OFF"] },
        },
      });
      const isRepeat =
        !input.restructuredFromId && priorLoans > 0 && badPriorLoans === 0;

      // Snapshot the product's approval chain (if any) onto this loan.
      // We resolve the chain in the same tx as the create so a concurrent
      // admin edit can't mid-flight produce a half-stamped chain.
      const approvalSteps = await tx.loanApprovalStep.findMany({
        where: { productCode: input.productCode },
        orderBy: { order: "asc" },
      });
      // Only loans that need underwriter judgement enter the chain;
      // auto-approved / auto-rejected loans skip it (they already have
      // their final status set by the decision engine above).
      const willUseChain =
        initialStatus === "SUBMITTED" && approvalSteps.length > 0;

      const created = await tx.loanApplication.create({
        data: {
          number,
          customerId: input.customerId,
          productCode: input.productCode,
          principal: input.principal,
          termMonths: input.termMonths,
          annualInterestRate: rate,
          purpose: input.purpose,
          creditScoreAtApply: input.creditScoreAtApply,
          tierAtApply: input.tierAtApply,
          status: initialStatus,
          decisionReason: input.initialDecisionReason,
          decidedAt: initialStatus === "SUBMITTED" ? null : new Date(),
          decidedById:
            initialStatus === "SUBMITTED" ? null : input.submittedById,
          submittedById: input.submittedById,
          vehicleId,
          propertyId,
          applicationSelfieUrl: input.applicationSelfieUrl,
          kycDeclarations: (input.kycDeclarations ?? undefined) as never,
          restructuredFromId: input.restructuredFromId,
          renewedFromId: input.renewedFromId,
          isRepeat,
          currentApprovalStep: willUseChain ? 1 : null,
        },
      });

      if (willUseChain) {
        for (const step of approvalSteps) {
          await tx.loanApproval.create({
            data: {
              loanId: created.id,
              stepOrder: step.order,
              stepLabel: step.label,
              requiredPermission: step.requiredPermission,
              status: "PENDING",
            },
          });
        }
      }

      return created;
    });
  }

  async decide(
    idOrNumber: string,
    input: LoanDecideInput,
  ): Promise<LoanApplication> {
    // Unlike the other writers this had no lookup — it updated straight
    // off the caller's id. A number needs resolving to one first.
    const found = await this.prisma.loanApplication.findFirst({
      where: idOrNumberWhere(idOrNumber),
      select: { id: true },
    });
    if (!found) throw new Error("Loan not found");
    return this.prisma.loanApplication.update({
      where: { id: found.id },
      data: {
        status: input.status,
        decisionReason: input.reason,
        decidedAt: new Date(),
        decidedById: input.decidedById,
      },
    });
  }

  /**
   * Persist a face-match score computed client-side. Five columns get
   * written atomically; the caller is responsible for any audit log
   * row when `passed === false`. The shape is intentionally narrow so
   * the API can validate inputs in one place.
   */
  async setSelfieMatch(
    idOrNumber: string,
    input: {
      score: number;
      distance: number;
      passed: boolean;
      model: string;
    },
  ): Promise<LoanApplication> {
    const found = await this.prisma.loanApplication.findFirst({
      where: idOrNumberWhere(idOrNumber),
      select: { id: true },
    });
    if (!found) throw new Error("Loan not found");
    return this.prisma.loanApplication.update({
      where: { id: found.id },
      data: {
        selfieMatchScore: input.score,
        selfieMatchDistance: input.distance,
        selfieMatchPassed: input.passed,
        selfieMatchModel: input.model,
        selfieMatchedAt: new Date(),
      },
    });
  }

  /**
   * Disburse an APPROVED loan: materialize the schedule (using the product's
   * interest method + payment frequency) and post the disbursement journal
   * entry — including processing + documentary stamp fees as fee income.
   */
  async disburse(
    idOrNumber: string,
    input: { disbursedById: string },
  ): Promise<LoanApplication> {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loanApplication.findFirst({
        where: idOrNumberWhere(idOrNumber),
        include: { product: true },
      });
      if (!loan) throw new Error("Loan not found");
      /*
       * Accepts a loan number as well as a UUID. Everything below this
       * lookup uses `id`, rebound to the row's real id — the later
       * update/delete clauses all key on it, so resolving only the lookup
       * would leave them matching a number against a uuid column.
       */
      const id = loan.id;
      if (loan.status !== "APPROVED") {
        throw new Error(`Cannot disburse from status ${loan.status}`);
      }
      const product = loan.product;
      const principal = Number(loan.principal);
      const annual = Number(loan.annualInterestRate);
      const method = product.interestMethod;
      const frequency = product.paymentFrequency;
      const schedule = computeAmortizationFor(
        principal,
        annual,
        loan.termMonths,
        {
          method,
          frequency,
        },
      );

      const today = new Date();
      const periodInc = daysBetweenInstallments(frequency);
      await tx.loanSchedule.createMany({
        data: schedule.map((row, idx) => ({
          loanId: loan.id,
          installmentNo: idx + 1,
          dueDate: nextDueDate(today, idx + 1, periodInc),
          principalDue: row.principal,
          interestDue: row.interest,
          totalDue: row.payment,
        })),
      });

      // Compute fees and post the disbursement entry with fee income line.
      const fees = computeFees(principal, {
        processingFeeRate: Number(product.processingFeeRate),
        processingFeeFlat: Number(product.processingFeeFlat),
        documentaryStampRate: Number(product.documentaryStampRate),
      });
      await this.accounting.postIfAbsent(
        loanDisbursementEntry({
          loanId: loan.id,
          loanNumber: loan.number,
          principal,
          feeTotal: fees.total,
          disbursedAt: today,
        }),
        { postedById: input.disbursedById, tx },
      );

      /*
       * Renewal settlement — the moment the netting actually happens.
       *
       * A renewal's proceeds pay off the loan it replaces. That has to
       * occur HERE, at disbursement, and inside this transaction: any
       * earlier and the lender would have written off a live balance
       * against a loan that might still be declined; any later and
       * there is a window where the borrower holds both debts at once.
       *
       * The old loan is settled exactly as an early close would settle
       * it — every open instalment marked paid, one payment row, one
       * journal entry — because as far as the ledger is concerned that
       * is precisely what happened. The only difference is where the
       * cash came from, which is why the reference says so.
       *
       * The borrower receives `principal - payoff`. That difference is
       * not computed here; `renewalPayoffAmount` is stamped on the row
       * so the disbursement voucher and the borrower's statement can
       * both show what was withheld and why.
       */
      let renewalPayoff: number | null = null;
      if (loan.renewedFromId) {
        const old = await tx.loanApplication.findUnique({
          where: { id: loan.renewedFromId },
          include: { schedule: { where: { paidInFullAt: null } } },
        });
        if (!old) throw new Error("Renewed loan not found");
        if (old.status !== "ACTIVE" && old.status !== "DISBURSED") {
          // It closed between application and disbursement — paid off
          // in cash, perhaps. Nothing to settle, and settling anyway
          // would double-credit it.
          renewalPayoff = 0;
        } else {
          const outstanding = round2(
            old.schedule.reduce(
              (sum, r) =>
                sum +
                (Number(r.principalDue) - Number(r.principalPaid)) +
                (Number(r.interestDue) - Number(r.interestPaid)),
              0,
            ),
          );
          renewalPayoff = outstanding;

          if (outstanding > 0) {
            const settlement = await tx.loanPayment.create({
              data: {
                loanId: old.id,
                amount: outstanding,
                paidOn: today,
                reference: `RENEWAL_SETTLEMENT ${loan.number}`,
                recordedById: input.disbursedById,
              },
            });
            const principalPortion = round2(
              old.schedule.reduce(
                (sum, r) =>
                  sum + (Number(r.principalDue) - Number(r.principalPaid)),
                0,
              ),
            );
            for (const inst of old.schedule) {
              await tx.loanSchedule.update({
                where: { id: inst.id },
                data: {
                  paidInFullAt: today,
                  principalPaid: inst.principalDue,
                  interestPaid: inst.interestDue,
                },
              });
            }
            await this.accounting.postIfAbsent(
              loanPaymentEntry({
                loanId: old.id,
                loanNumber: old.number,
                paymentId: settlement.id,
                amount: outstanding,
                interestPortion: round2(outstanding - principalPortion),
                principalPortion,
                paidOn: today,
              }),
              { postedById: input.disbursedById, tx },
            );
          }
          await tx.loanApplication.update({
            where: { id: old.id },
            data: { status: "CLOSED", closedAt: today },
          });
        }
      }

      const updated = await tx.loanApplication.update({
        where: { id },
        data: {
          status: "ACTIVE",
          disbursedAt: today,
          disbursedById: input.disbursedById,
          renewalPayoffAmount: renewalPayoff,
        },
      });

      // Lease-to-Own: when the product is a lease, snapshot a
      // LeaseAgreement so the residual buyout + pull-out flows have somewhere
      // to attach. Employee scoping is inferred from the customer's
      // employmentStatus until we have a stronger "company employee" signal.
      if (product.isLease) {
        const residualFraction = Number(product.residualValueFraction ?? 0);
        const residual = round2(principal * residualFraction);
        const customer = await tx.customer.findUnique({
          where: { id: loan.customerId },
        });
        // Treat any EMPLOYED customer as employee for now. A future phase
        // can promote this to an explicit "isCompanyEmployee" flag.
        const isEmployee = customer?.employmentStatus === "EMPLOYED";
        await tx.leaseAgreement.upsert({
          where: { loanId: loan.id },
          create: {
            loanId: loan.id,
            residualValue: residual,
            isEmployee,
          },
          update: {},
        });
      }

      return updated;
    });
  }

  /**
   * Record a payment + auto-post journal entry.
   *
   * Allocation walks the open installments oldest-first, clearing each one's
   * *remaining* interest before its remaining principal. "Remaining" is the
   * key word: every payment persists its slice to `interestPaid` /
   * `principalPaid`, and the next payment allocates against
   * `interestDue - interestPaid` / `principalDue - principalPaid`.
   *
   * That is what makes partial payments behave. Allocating against the full
   * dues instead — which is what this did before — recognizes the same
   * interest once per payment: an installment of 1,000 interest + 4,000
   * principal paid as five 1,000s booked 5,000 of interest income and zero
   * principal. Every one of those entries balanced individually, so
   * `buildEntry` had nothing to complain about.
   *
   * An installment is settled once its CUMULATIVE progress covers it, not
   * when a single payment does. Marking on a single payment's amount left a
   * borrower paying 5,000 as two 2,500s with the installment still open
   * forever — the loan never closed and late fees kept accruing, since
   * `lateFeeFor` charges any row whose `paidInFullAt` is null.
   *
   * Anything left after the whole schedule is settled is an overpayment. It
   * is booked to Customer Advances (a liability), never as extra principal —
   * crediting Loans Receivable past zero would misstate the asset.
   */
  async recordPayment(
    loanIdOrNumber: string,
    input: RecordPaymentInput,
  ): Promise<LoanPayment> {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loanApplication.findFirst({
        where: idOrNumberWhere(loanIdOrNumber),
      });
      if (!loan) throw new Error("Loan not found");
      /*
       * A loan that was never disbursed has no receivable to settle.
       * Without this the payment was accepted, a journal entry posted,
       * and the loan then CLOSED — see the schedule check further down —
       * so money could be booked against an application nobody approved.
       */
      if (!PAYABLE_STATUSES.has(loan.status)) {
        throw new LoanNotPayableError(loan.number, loan.status);
      }
      /*
       * Accepts a loan number as well as a UUID. Everything below this
       * lookup uses `loanId`, rebound to the row's real id — the later
       * update/delete clauses all key on it, so resolving only the lookup
       * would leave them matching a number against a uuid column.
       */
      const loanId = loan.id;

      const payment = await tx.loanPayment.create({
        data: {
          loanId,
          amount: input.amount,
          paidOn: input.paidOn,
          reference: input.reference,
          recordedById: input.recordedById,
        },
      });

      const open = await tx.loanSchedule.findMany({
        where: { loanId, paidInFullAt: null },
        orderBy: { installmentNo: "asc" },
      });

      const allocation = allocatePayment(
        Number(input.amount),
        open.map((o) => ({
          interestDue: Number(o.interestDue),
          principalDue: Number(o.principalDue),
          interestPaid: Number(o.interestPaid),
          principalPaid: Number(o.principalPaid),
        })),
      );

      // Persist the per-installment progress. `perInstallment[].index` maps
      // back into `open`, and only installments that actually received money
      // are present.
      for (const slice of allocation.perInstallment) {
        const inst = open[slice.index]!;
        const interestPaid = round2(Number(inst.interestPaid) + slice.interest);
        const principalPaid = round2(
          Number(inst.principalPaid) + slice.principal,
        );
        const settled =
          interestPaid + 0.005 >= Number(inst.interestDue) &&
          principalPaid + 0.005 >= Number(inst.principalDue);
        await tx.loanSchedule.update({
          where: { id: inst.id },
          data: {
            interestPaid,
            principalPaid,
            paidInFullAt: settled ? input.paidOn : null,
          },
        });
      }

      await this.accounting.postIfAbsent(
        loanPaymentEntry({
          loanId,
          loanNumber: loan.number,
          paymentId: payment.id,
          amount: Number(input.amount),
          interestPortion: allocation.interest,
          principalPortion: allocation.principal,
          advancePortion: allocation.overpayment,
          paidOn: input.paidOn,
        }),
        { postedById: input.recordedById, tx },
      );

      const [stillOpen, installments] = await Promise.all([
        tx.loanSchedule.count({ where: { loanId, paidInFullAt: null } }),
        tx.loanSchedule.count({ where: { loanId } }),
      ]);
      /*
       * `stillOpen === 0` alone reads "every installment is settled", but
       * it is equally true when there are NO installments — which is any
       * loan whose schedule was never generated. That is what let a
       * payment on an undisbursed loan close it. Requiring a non-empty
       * schedule makes the two cases distinguishable.
       *
       * The status check is separate: a stray payment against an already
       * closed loan is all overpayment, and re-stamping `closedAt` would
       * rewrite the real closure date.
       */
      if (installments > 0 && stillOpen === 0 && loan.status !== "CLOSED") {
        await tx.loanApplication.update({
          where: { id: loanId },
          data: { status: "CLOSED", closedAt: new Date() },
        });
      }
      return payment;
    });
  }

  /**
   * Bulk-record payments. Each row resolves to a loanId (either provided
   * directly or looked up by loanNumber), then runs through `recordPayment`
   * (which transactionally writes the payment, updates the schedule, and
   * posts the journal entry).
   *
   * Per-row failures are returned as `ok:false` with an error message;
   * successful rows still commit. Pass `stopOnError:true` to short-circuit.
   */
  async recordPaymentsBulk(
    rows: BulkPaymentRow[],
    recordedById: string,
    opts: { stopOnError?: boolean } = {},
  ): Promise<BulkPaymentRowResult[]> {
    const out: BulkPaymentRowResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      try {
        let loanId = row.loanId ?? null;
        let number = row.loanNumber ?? "";
        if (!loanId && row.loanNumber) {
          const loan = await this.prisma.loanApplication.findUnique({
            where: { number: row.loanNumber },
            select: { id: true, number: true },
          });
          if (!loan)
            throw new Error(`Loan number not found: ${row.loanNumber}`);
          loanId = loan.id;
          number = loan.number;
        }
        if (!loanId) throw new Error("Each row needs loanId or loanNumber.");
        if (!row.amount || row.amount <= 0)
          throw new Error("Amount must be > 0.");

        const payment = await this.recordPayment(loanId, {
          amount: row.amount,
          paidOn: row.paidOn ?? new Date(),
          reference: row.reference,
          recordedById,
        });
        out.push({
          index: i,
          loanNumber: number,
          loanId,
          ok: true,
          paymentId: payment.id,
        });
      } catch (err) {
        out.push({
          index: i,
          loanNumber: row.loanNumber ?? row.loanId ?? "?",
          loanId: row.loanId ?? null,
          ok: false,
          error: (err as Error).message,
        });
        if (opts.stopOnError) break;
      }
    }
    return out;
  }

  /**
   * Settle the loan early. Computes the remaining principal + the
   * product's pre-termination fee, records both as a single LoanPayment,
   * posts the disbursement-side fee income entry, and closes the loan.
   */
  async closeEarly(loanIdOrNumber: string, input: CloseEarlyInput) {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loanApplication.findFirst({
        where: idOrNumberWhere(loanIdOrNumber),
        include: {
          product: true,
          schedule: { where: { paidInFullAt: null } },
        },
      });
      if (!loan) throw new Error("Loan not found");
      if (loan.status !== "ACTIVE" && loan.status !== "DISBURSED") {
        throw new Error(`Cannot close early from status ${loan.status}`);
      }
      /*
       * Rebound to the row's real id. Everything below keys on `loanId`
       * for its updates, so resolving only the lookup would leave them
       * matching a loan number against a uuid column.
       */
      const loanId = loan.id;

      const remainingPrincipal = loan.schedule.reduce(
        (sum, s) => sum + (Number(s.principalDue) - Number(s.principalPaid)),
        0,
      );
      const fee = round2(
        remainingPrincipal * Number(loan.product.preTerminationFeeRate),
      );
      const due = round2(remainingPrincipal + fee);
      if (input.settlementAmount + 0.005 < due) {
        throw new Error(
          `Settlement ${input.settlementAmount} is less than required ${due} (principal ${remainingPrincipal} + fee ${fee}).`,
        );
      }

      const payment = await tx.loanPayment.create({
        data: {
          loanId,
          amount: input.settlementAmount,
          paidOn: new Date(),
          reference: input.reference ?? "EARLY_SETTLEMENT",
          recordedById: input.closedById,
        },
      });

      // Mark every open installment paid. `interestPaid` moves with
      // `principalPaid` so a settled row reads as having nothing remaining;
      // recognized income is the journal entries' business, not this column's.
      for (const inst of loan.schedule) {
        await tx.loanSchedule.update({
          where: { id: inst.id },
          data: {
            paidInFullAt: new Date(),
            principalPaid: inst.principalDue,
            interestPaid: inst.interestDue,
          },
        });
      }

      // Post the principal portion (Dr Cash / Cr Loans Receivable).
      await this.accounting.postIfAbsent(
        loanPaymentEntry({
          loanId,
          loanNumber: loan.number,
          paymentId: payment.id,
          amount: remainingPrincipal,
          interestPortion: 0,
          principalPortion: remainingPrincipal,
          paidOn: new Date(),
        }),
        { postedById: input.closedById, tx },
      );

      // Post the pre-termination fee separately so reporting can see the fee income.
      if (fee > 0) {
        await this.accounting.postIfAbsent(
          preTerminationFeeEntry({
            loanId,
            loanNumber: loan.number,
            fee,
            closedAt: new Date(),
          }),
          { postedById: input.closedById, tx },
        );
      }

      const updated = await tx.loanApplication.update({
        where: { id: loanId },
        data: { status: "CLOSED", closedAt: new Date() },
      });
      return {
        loan: updated,
        payment,
        remainingPrincipal,
        fee,
        totalSettled: due,
      };
    });
  }

  /**
   * Restructure a loan. Creates a *new* loan (status APPROVED, linked back via
   * restructuredFromId) and marks the original RESTRUCTURED. The remaining
   * principal of the original is "settled" against the new loan inside one
   * transaction so the ledger stays balanced:
   *
   *   Dr Loans Receivable (new)   newPrincipal
   *     Cr Loans Receivable (old) remainingPrincipal
   *     Cr Cash                   topUp        (only if newPrincipal > remaining)
   *
   * If newPrincipal < remaining we treat the difference as a partial
   * write-down (Dr Bad Debt) — happens when the customer settles for less.
   *
   * Returns both rows so the API can show "this loan is now LN-2026-000045".
   */
  async restructure(
    originalIdOrNumber: string,
    input: RestructureInput,
  ): Promise<{ original: LoanApplication; replacement: LoanApplication }> {
    return this.prisma.$transaction(async (tx) => {
      const original = await tx.loanApplication.findFirst({
        where: idOrNumberWhere(originalIdOrNumber),
        include: {
          schedule: { where: { paidInFullAt: null } },
          customer: true,
        },
      });
      if (!original) throw new Error("Loan not found");
      if (!["ACTIVE", "DISBURSED", "DEFAULTED"].includes(original.status)) {
        throw new Error(`Cannot restructure from status ${original.status}`);
      }
      if (original.restructuredFromId) {
        throw new Error(
          "Cannot chain restructures off the same row; restructure the most recent loan in the chain.",
        );
      }

      const remainingPrincipal = original.schedule.reduce(
        (s, x) => s + (Number(x.principalDue) - Number(x.principalPaid)),
        0,
      );

      // Mark every open installment on the original paid (settlement).
      for (const inst of original.schedule) {
        await tx.loanSchedule.update({
          where: { id: inst.id },
          data: {
            paidInFullAt: new Date(),
            principalPaid: inst.principalDue,
            interestPaid: inst.interestDue,
          },
        });
      }
      const updatedOriginal = await tx.loanApplication.update({
        // The row we resolved, not the caller's identifier, which may
        // have been a loan number.
        where: { id: original.id },
        data: {
          status: "RESTRUCTURED",
          closedAt: new Date(),
        },
      });

      // Create the new loan, copying customer + collateral, linked back.
      // Per-product validation + tier-pricing reuses `apply`.
      const replacement = await this.applyInTx(tx, {
        customerId: original.customerId,
        productCode: input.productCode,
        principal: input.principal,
        termMonths: input.termMonths,
        annualInterestRate: input.annualInterestRate,
        purpose: input.purpose ?? `Restructure of ${original.number}`,
        creditScoreAtApply: original.creditScoreAtApply,
        tierAtApply: original.tierAtApply,
        submittedById: input.restructuredById,
        initialStatus: "APPROVED",
        initialDecisionReason: `Restructure of ${original.number} (remaining ${remainingPrincipal.toFixed(2)})`,
        restructuredFromId: original.id,
      });

      // Post the settlement journal entry.
      const topUp = round2(input.principal - remainingPrincipal);
      const writeDown = round2(remainingPrincipal - input.principal);
      const { ACCOUNT_CODES, buildEntry } = await import("@loan/accounting");
      const lines: Array<{
        accountCode: string;
        debit: number;
        credit: number;
        memo?: string;
      }> = [
        {
          accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
          debit: input.principal,
          credit: 0,
          memo: `Restructure: new loan ${replacement.number}`,
        },
        {
          accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
          debit: 0,
          credit: remainingPrincipal,
          memo: `Restructure: settle ${original.number}`,
        },
      ];
      if (topUp > 0) {
        // Customer is getting cash for the difference.
        lines.push({
          accountCode: ACCOUNT_CODES.CASH,
          debit: 0,
          credit: topUp,
          memo: "Top-up disbursement",
        });
      } else if (writeDown > 0) {
        // We forgave some principal — Dr Bad Debt to balance.
        lines.push({
          accountCode: ACCOUNT_CODES.BAD_DEBT_EXPENSE,
          debit: writeDown,
          credit: 0,
          memo: "Partial write-down at restructure",
        });
      }
      await this.accounting.postIfAbsent(
        buildEntry({
          entryDate: new Date(),
          source: "MANUAL",
          sourceRefType: "LoanRestructure",
          sourceRefId: replacement.id,
          memo: `Restructure ${original.number} → ${replacement.number}`,
          lines,
        }),
        { postedById: input.restructuredById, tx },
      );

      return { original: updatedOriginal, replacement };
    });
  }

  /**
   * Write off a loan. Posts the remaining principal as Bad Debt Expense and
   * marks the loan WRITTEN_OFF. The customer's behavioral score takes the
   * hit on next recompute.
   *
   *   Dr Bad Debt Expense      remainingPrincipal
   *     Cr Loans Receivable    remainingPrincipal
   */
  async writeOff(
    idOrNumber: string,
    input: WriteOffInput,
  ): Promise<{ loan: LoanApplication; amount: number }> {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loanApplication.findFirst({
        where: idOrNumberWhere(idOrNumber),
        include: { schedule: { where: { paidInFullAt: null } } },
      });
      if (!loan) throw new Error("Loan not found");
      /*
       * Rebound to the row's real id — the writes below key on it, and
       * a loan number would not match the uuid column.
       */
      const id = loan.id;
      if (loan.status === "WRITTEN_OFF" || loan.status === "CLOSED") {
        throw new Error(`Cannot write off from status ${loan.status}`);
      }

      const remaining = loan.schedule.reduce(
        (s, x) => s + (Number(x.principalDue) - Number(x.principalPaid)),
        0,
      );
      const amount = round2(remaining);

      for (const inst of loan.schedule) {
        await tx.loanSchedule.update({
          where: { id: inst.id },
          data: {
            paidInFullAt: new Date(),
            principalPaid: inst.principalDue,
            interestPaid: inst.interestDue,
          },
        });
      }

      if (amount > 0) {
        const { ACCOUNT_CODES, buildEntry } = await import("@loan/accounting");
        await this.accounting.postIfAbsent(
          buildEntry({
            entryDate: new Date(),
            source: "MANUAL",
            sourceRefType: "LoanWriteOff",
            sourceRefId: loan.id,
            memo: `Write-off ${loan.number}: ${input.reason}`,
            lines: [
              {
                accountCode: ACCOUNT_CODES.BAD_DEBT_EXPENSE,
                debit: amount,
                credit: 0,
                memo: input.reason,
              },
              {
                accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
                debit: 0,
                credit: amount,
                memo: `Write-off of ${loan.number}`,
              },
            ],
          }),
          { postedById: input.writtenOffById, tx },
        );
      }

      const updated = await tx.loanApplication.update({
        where: { id },
        data: {
          status: "WRITTEN_OFF",
          writeOffAmount: amount,
          writeOffReason: input.reason,
          writtenOffAt: new Date(),
          writtenOffById: input.writtenOffById,
          closedAt: new Date(),
        },
      });
      return { loan: updated, amount };
    });
  }

  // ─── Penalty waive ────────────────────────────────────────────────────
  //
  // Daily LATE_FEE_ACCRUAL postings are Dr Loans Receivable / Cr Fee Income.
  // The sum of Fee Income credits across all LATE_FEE_ACCRUAL entries for
  // this loan, minus the sum of prior waivedAmount, is the "current accrued
  // penalty" the UI shows. Waiving posts a reversing entry for the waived
  // portion (Dr Fee Income / Cr Loans Receivable).

  /**
   * Current outstanding penalty for a loan = total late-fee accruals
   * minus prior waivers. Cheap enough to compute on demand from JE rows;
   * we keep no running counter to avoid drift.
   */
  async accruedPenaltiesFor(loanIdOrNumber: string): Promise<{
    originalPenalty: number;
    waivedToDate: number;
    outstanding: number;
  }> {
    const loan = await this.prisma.loanApplication.findFirst({
      where: idOrNumberWhere(loanIdOrNumber),
      include: { schedule: { select: { id: true } } },
    });
    if (!loan) throw new Error("Loan not found");
    const scheduleIds = loan.schedule.map((s) => s.id);
    if (scheduleIds.length === 0) {
      return { originalPenalty: 0, waivedToDate: 0, outstanding: 0 };
    }
    // Look up all LATE_FEE_ACCRUAL entries whose sourceRefId starts with any
    // of this loan's schedule ids (the daily key is appended after a colon).
    const accruals = await this.prisma.journalEntry.findMany({
      where: {
        source: "LATE_FEE_ACCRUAL",
        sourceRefType: "LoanScheduleLateFee",
        OR: scheduleIds.map((sid) => ({
          sourceRefId: { startsWith: `${sid}:` },
        })),
      },
      include: { lines: { include: { account: true } } },
    });
    const originalPenalty = accruals.reduce((sum, e) => {
      const feeLine = e.lines.find((l) => l.account.code === "4100");
      return sum + (feeLine ? Number(feeLine.credit) : 0);
    }, 0);

    const waivers = await this.prisma.penaltyWaiver.findMany({
      where: { loanId: loan.id },
      select: { waivedAmount: true },
    });
    const waivedToDate = waivers.reduce(
      (sum, w) => sum + Number(w.waivedAmount),
      0,
    );

    return {
      originalPenalty: round2(originalPenalty),
      waivedToDate: round2(waivedToDate),
      outstanding: round2(originalPenalty - waivedToDate),
    };
  }

  /**
   * Waive part (or all) of the outstanding penalty. Posts a reversing
   * journal entry and creates a PenaltyWaiver record snapshot. Gated by
   * `loans.waive_penalty` permission at the route layer.
   */
  async waivePenalty(
    loanIdOrNumber: string,
    input: {
      waivedAmount: number;
      reason: string;
      waivedById: string;
    },
  ): Promise<{
    waiver: { id: string; originalPenalty: number; negotiatedPenalty: number };
    journalEntryId: string;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loanApplication.findFirst({
        where: idOrNumberWhere(loanIdOrNumber),
      });
      if (!loan) throw new Error("Loan not found");
      /*
       * Rebound to the row's real id — the writes below key on it, and
       * a loan number would not match the uuid column.
       */
      const loanId = loan.id;

      // Reuse the public method's logic but read inside the txn so the
      // snapshot stays consistent if accruals are running concurrently.
      const scheduleRows = await tx.loanSchedule.findMany({
        where: { loanId },
        select: { id: true },
      });
      const scheduleIds = scheduleRows.map((s) => s.id);
      const accruals =
        scheduleIds.length === 0
          ? []
          : await tx.journalEntry.findMany({
              where: {
                source: "LATE_FEE_ACCRUAL",
                sourceRefType: "LoanScheduleLateFee",
                OR: scheduleIds.map((sid) => ({
                  sourceRefId: { startsWith: `${sid}:` },
                })),
              },
              include: { lines: { include: { account: true } } },
            });
      const originalAccrued = accruals.reduce((sum, e) => {
        const feeLine = e.lines.find((l) => l.account.code === "4100");
        return sum + (feeLine ? Number(feeLine.credit) : 0);
      }, 0);
      const priorWaivers = await tx.penaltyWaiver.findMany({
        where: { loanId },
        select: { waivedAmount: true },
      });
      const waivedSoFar = priorWaivers.reduce(
        (s, w) => s + Number(w.waivedAmount),
        0,
      );
      const originalPenalty = round2(originalAccrued - waivedSoFar);

      const waivedAmount = round2(input.waivedAmount);
      if (waivedAmount <= 0) throw new Error("Waive amount must be > 0");
      if (waivedAmount > originalPenalty + 0.005) {
        throw new Error(
          `Waive amount ${waivedAmount} exceeds outstanding penalty ${originalPenalty}`,
        );
      }
      const negotiatedPenalty = round2(originalPenalty - waivedAmount);

      // Create the waiver row first (so the journal entry's sourceRefId
      // can reference it for idempotency).
      const waiver = await tx.penaltyWaiver.create({
        data: {
          loanId,
          originalPenalty,
          waivedAmount,
          negotiatedPenalty,
          reason: input.reason.slice(0, 500),
          waivedById: input.waivedById,
        },
      });

      // Lazy-import to keep the accounting lib out of the cold path of
      // every db package consumer.
      const { penaltyWaiveEntry } = await import("@loan/accounting");
      const entry = penaltyWaiveEntry({
        waiverId: waiver.id,
        loanId: loan.id,
        loanNumber: loan.number,
        waivedAmount,
        waivedOn: new Date(),
        reason: input.reason,
      });
      const result = await this.accounting.postIfAbsent(entry, {
        postedById: input.waivedById,
        tx,
      });

      // Link the waiver to the journal entry now that we have its id.
      await tx.penaltyWaiver.update({
        where: { id: waiver.id },
        data: { journalEntryId: result.entry.id },
      });

      return {
        waiver: {
          id: waiver.id,
          originalPenalty,
          negotiatedPenalty,
        },
        journalEntryId: result.entry.id,
      };
    });
  }

  /** List historical waivers on a loan (drawer / audit-trail surface). */
  async listPenaltyWaivers(loanIdOrNumber: string) {
    const loan = await this.prisma.loanApplication.findFirst({
      where: idOrNumberWhere(loanIdOrNumber),
      select: { id: true },
    });
    if (!loan) return [];
    return this.prisma.penaltyWaiver.findMany({
      where: { loanId: loan.id },
      orderBy: { waivedAt: "desc" },
      include: {
        waivedBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /**
   * Internal helper — same logic as `apply()` but runs inside an existing
   * transaction. Extracted so `restructure()` can chain.
   */
  private async applyInTx(
    tx: Prisma.TransactionClient,
    input: LoanApplyInput,
  ): Promise<LoanApplication> {
    const product = await tx.loanProduct.findUnique({
      where: { code: input.productCode },
    });
    if (!product || !product.active) {
      throw new Error(`Loan product ${input.productCode} is not available.`);
    }
    const number = await this.nextApplicationNumber(tx);
    const initialStatus = (input.initialStatus ?? "SUBMITTED") as LoanStatus;
    return tx.loanApplication.create({
      data: {
        number,
        customerId: input.customerId,
        productCode: input.productCode,
        principal: input.principal,
        termMonths: input.termMonths,
        annualInterestRate: input.annualInterestRate,
        purpose: input.purpose,
        creditScoreAtApply: input.creditScoreAtApply,
        tierAtApply: input.tierAtApply,
        status: initialStatus,
        decisionReason: input.initialDecisionReason,
        decidedAt: initialStatus === "SUBMITTED" ? null : new Date(),
        decidedById: initialStatus === "SUBMITTED" ? null : input.submittedById,
        submittedById: input.submittedById,
        restructuredFromId: input.restructuredFromId,
      },
    });
  }

  private async nextApplicationNumber(
    client:
      | PrismaClient
      | Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0] = this
      .prisma,
  ): Promise<string> {
    const year = new Date().getFullYear();
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const last = await client.loanApplication.findFirst({
      where: { submittedAt: { gte: yearStart, lt: yearEnd } },
      orderBy: { submittedAt: "desc" },
    });
    let seq = 1;
    if (last) {
      const match = /LN-\d{4}-(\d+)/.exec(last.number);
      if (match) seq = Number(match[1]) + 1;
    }
    return `LN-${year}-${String(seq).padStart(6, "0")}`;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function toConfig(p: LoanProduct): LoanProductConfig & { defaultRate: number } {
  return {
    code: p.code,
    collateralKind: p.collateralKind,
    minPrincipal: Number(p.minPrincipal),
    maxPrincipal: Number(p.maxPrincipal),
    minTermMonths: p.minTermMonths,
    maxTermMonths: p.maxTermMonths,
    minRate: Number(p.minRate),
    maxRate: Number(p.maxRate),
    maxLoanToValue: p.maxLoanToValue == null ? null : Number(p.maxLoanToValue),
    rateByTier: (p.rateByTier as LoanProductConfig["rateByTier"]) ?? null,
    ltvByTier: (p.ltvByTier as LoanProductConfig["ltvByTier"]) ?? null,
    defaultRate: Number(p.defaultRate),
  };
}

function nextDueDate(
  start: Date,
  installmentNo: number,
  inc: number | "MONTH",
): Date {
  const due = new Date(start);
  if (inc === "MONTH") {
    due.setMonth(due.getMonth() + installmentNo);
  } else {
    due.setDate(due.getDate() + inc * installmentNo);
  }
  return due;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Suppress unused warnings for helpers that callers reference.
void effectiveMaxLtv;
void installmentCount;
