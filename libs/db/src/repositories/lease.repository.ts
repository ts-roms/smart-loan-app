/**
 * Lease-to-Own repository — FRD §3.5.
 *
 * A lease agreement is auto-created when a loan with `product.isLease=true`
 * is disbursed. The standard amortization handles monthly rentals; this
 * repo owns:
 *
 *   * The residual buyout flow (charges the residual, posts the GL entry,
 *     transitions to BUYOUT_COMPLETED, flips the title holder).
 *   * Pull-out tracking for non-employees (3 consecutive missed payments
 *     triggers a PULLED_OUT state — the loan officer follows up with the
 *     repossession workflow for the actual vehicle recovery).
 *   * End-of-term + maintenance reminder bookkeeping (gated via
 *     lastReminderAt fields so the daily job doesn't spam).
 */

import type { LeaseAgreement, LeaseStatus, PrismaClient } from "@prisma/client";

import { AccountingRepository } from "./accounting.repository";

export interface CreateLeaseInput {
  loanId: string;
  residualValue: number;
  isEmployee: boolean;
}

export interface BuyoutInput {
  loanId: string;
  amountPaid: number;
  buyoutById: string;
}

export interface PullOutInput {
  loanId: string;
  reason: string;
  pulledOutById: string;
}

export class LeaseRepository {
  private readonly accounting: AccountingRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.accounting = new AccountingRepository(prisma);
  }

  /** Create an agreement when the loan disburses. Idempotent on loanId. */
  async createForLoan(input: CreateLeaseInput): Promise<LeaseAgreement> {
    const existing = await this.prisma.leaseAgreement.findUnique({
      where: { loanId: input.loanId },
    });
    if (existing) return existing;
    return this.prisma.leaseAgreement.create({
      data: {
        loanId: input.loanId,
        residualValue: input.residualValue,
        isEmployee: input.isEmployee,
      },
    });
  }

  async findForLoan(loanId: string): Promise<LeaseAgreement | null> {
    return this.prisma.leaseAgreement.findUnique({ where: { loanId } });
  }

  async list(filter?: {
    status?: LeaseStatus;
    take?: number;
  }): Promise<
    Array<LeaseAgreement & { loan: { number: string; customerId: string } }>
  > {
    return this.prisma.leaseAgreement.findMany({
      where: { status: filter?.status },
      include: { loan: { select: { number: true, customerId: true } } },
      orderBy: { createdAt: "desc" },
      take: filter?.take ?? 200,
    });
  }

  /**
   * Borrower paid the residual + takes title. Posts the buyout JE,
   * transitions to BUYOUT_COMPLETED, flips titleHolder to CUSTOMER,
   * and closes the loan.
   */
  async completeBuyout(input: BuyoutInput): Promise<{
    agreement: LeaseAgreement;
    journalEntryId: string;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.leaseAgreement.findUnique({
        where: { loanId: input.loanId },
        include: { loan: { select: { number: true } } },
      });
      if (!a) throw new Error("Lease agreement not found");
      if (a.status !== "ACTIVE" && a.status !== "EXTENDED") {
        throw new Error(`Cannot buy out from status ${a.status}`);
      }
      const residual = Number(a.residualValue);
      // Allow paying ≥ residual; over-payment is captured as-is so the
      // ledger reflects what changed hands (rare but possible if the
      // borrower also tops up missing rentals at the same time).
      //
      // The lower bound is enforced here rather than in the zod schema
      // because `residual` is per-agreement — the request schema can only
      // assert `> 0`. Without this, any positive amount bought out the
      // unit: ₱1 against a ₱50,000 residual transferred the asset and
      // posted ₱1 to the ledger.
      if (input.amountPaid <= 0) {
        throw new Error("Amount paid must be > 0");
      }
      if (round2(input.amountPaid) < round2(residual)) {
        throw new Error(
          `Buyout amount ${round2(input.amountPaid)} is below the residual value ${round2(residual)}`,
        );
      }

      const { leaseBuyoutEntry } = await import("@loan/accounting");
      const entry = leaseBuyoutEntry({
        agreementId: a.id,
        loanId: a.loanId,
        loanNumber: a.loan.number,
        residualAmount: round2(input.amountPaid),
        buyoutOn: new Date(),
      });
      const result = await this.accounting.postIfAbsent(entry, {
        postedById: input.buyoutById,
        tx,
      });

      // Close the loan + flip title.
      await tx.loanApplication.update({
        where: { id: a.loanId },
        data: { status: "CLOSED", closedAt: new Date() },
      });
      const updated = await tx.leaseAgreement.update({
        where: { id: a.id },
        data: {
          status: "BUYOUT_COMPLETED",
          titleHolder: "CUSTOMER",
          buyoutPaidAmount: input.amountPaid,
          buyoutAt: new Date(),
          buyoutById: input.buyoutById,
          buyoutJournalEntryId: result.entry.id,
        },
      });

      return { agreement: updated, journalEntryId: result.entry.id };
    });
  }

  /**
   * Pull out a vehicle from a non-employee in default. Sets status to
   * PULLED_OUT; the actual recovery is then driven by the existing
   * RepossessionCase workflow (Phase C).
   */
  async pullOut(input: PullOutInput): Promise<LeaseAgreement> {
    const a = await this.prisma.leaseAgreement.findUnique({
      where: { loanId: input.loanId },
    });
    if (!a) throw new Error("Lease agreement not found");
    if (a.status !== "ACTIVE") {
      throw new Error(`Cannot pull out from status ${a.status}`);
    }
    if (a.isEmployee) {
      throw new Error(
        "Pull-out is non-employee-only per FRD §3.5. Use restructure / collections for employee leases.",
      );
    }
    return this.prisma.leaseAgreement.update({
      where: { id: a.id },
      data: {
        status: "PULLED_OUT",
        pulledOutAt: new Date(),
        pulledOutById: input.pulledOutById,
        pullOutReason: input.reason.slice(0, 500),
      },
    });
  }

  /** End-of-term: borrower returned the vehicle instead of buying. */
  async closeAsReturned(
    loanId: string,
    reason: string,
  ): Promise<LeaseAgreement> {
    return this.closeWithStatus(loanId, "RETURNED", reason);
  }

  /** End-of-term: extended for a further period. */
  async closeAsExtended(
    loanId: string,
    reason: string,
  ): Promise<LeaseAgreement> {
    return this.closeWithStatus(loanId, "EXTENDED", reason);
  }

  private async closeWithStatus(
    loanId: string,
    status: "RETURNED" | "EXTENDED",
    reason: string,
  ): Promise<LeaseAgreement> {
    const a = await this.prisma.leaseAgreement.findUnique({
      where: { loanId },
    });
    if (!a) throw new Error("Lease agreement not found");
    if (a.status !== "ACTIVE") {
      throw new Error(`Cannot close from status ${a.status}`);
    }
    return this.prisma.leaseAgreement.update({
      where: { id: a.id },
      data: {
        status,
        closedAt: new Date(),
        closedReason: reason.slice(0, 500),
      },
    });
  }

  // ── Missed-payment tracking ──────────────────────────────────────────

  /**
   * Increment the missedPaymentStreak when an installment goes unpaid past
   * its grace period. Returns the agreement post-increment plus a flag
   * indicating whether the borrower should be pulled out now.
   */
  async incrementMissedPayment(loanId: string): Promise<{
    agreement: LeaseAgreement;
    shouldPullOut: boolean;
    threshold: number;
  }> {
    const a = await this.prisma.leaseAgreement.findUnique({
      where: { loanId },
      include: { loan: { include: { product: true } } },
    });
    if (!a) throw new Error("Lease agreement not found");
    const threshold = a.loan.product?.missedPaymentPullOutCount ?? 3;
    const updated = await this.prisma.leaseAgreement.update({
      where: { id: a.id },
      data: { missedPaymentStreak: { increment: 1 } },
    });
    const shouldPullOut =
      !a.isEmployee &&
      updated.missedPaymentStreak >= threshold &&
      a.status === "ACTIVE";
    return { agreement: updated, shouldPullOut, threshold };
  }

  async resetMissedPaymentStreak(loanId: string): Promise<LeaseAgreement> {
    return this.prisma.leaseAgreement.update({
      where: { loanId },
      data: { missedPaymentStreak: 0, lastPullOutWarningAt: null },
    });
  }

  async markMaintenanceReminderSent(loanId: string): Promise<void> {
    await this.prisma.leaseAgreement.update({
      where: { loanId },
      data: { lastMaintenanceReminderAt: new Date() },
    });
  }

  async markEndOfTermNoticeSent(loanId: string): Promise<void> {
    await this.prisma.leaseAgreement.update({
      where: { loanId },
      data: { endOfTermNoticeSentAt: new Date() },
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
