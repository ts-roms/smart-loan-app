/**
 * Repossession workflow repository.
 *
 * One active case per loan (enforced by unique constraint). The case
 * advances through the prescribed approval chain (BM → Credit Head
 * → Legal) before an agent can be dispatched. Auction settlement posts
 * the proceeds + any deficiency to the GL.
 *
 * State transitions are strict — each "advance" method validates the
 * current status before applying. Cancellation is allowed from any
 * pre-RECOVERED state.
 */

import type {
  PrismaClient,
  Prisma,
  RepossessionCase,
  RepossessionStatus,
} from "@prisma/client";

import { AccountingRepository } from "./accounting.repository";

export interface OpenCaseInput {
  loanId: string;
  reason: string;
  identifiedById: string;
}

export interface ApprovalInput {
  caseId: string;
  approvedById: string;
  note?: string;
}

export interface AssignAgentInput {
  caseId: string;
  agentName: string;
  agentContact: string;
  assignedById: string;
}

export interface RecoverInput {
  caseId: string;
  vehicleCondition: string;
  vehicleMileage?: number;
  vehiclePhotos?: string[];
  storageLocation: string;
  outstandingAtRecovery: number;
  recoveredById: string;
}

export interface AuctionInput {
  caseId: string;
  auctionMethod: string;
  auctionProceeds: number;
  auctionedById: string;
}

export interface CancelInput {
  caseId: string;
  reason: string;
  cancelledById: string;
}

export class RepossessionRepository {
  private readonly accounting: AccountingRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.accounting = new AccountingRepository(prisma);
  }

  /** Open a new case (status = IDENTIFIED). Fails if one already exists. */
  async openCase(input: OpenCaseInput): Promise<RepossessionCase> {
    return this.prisma.repossessionCase.create({
      data: {
        loanId: input.loanId,
        reason: input.reason.slice(0, 500),
        identifiedById: input.identifiedById,
      },
    });
  }

  async list(filter?: {
    status?: RepossessionStatus;
    loanId?: string;
    take?: number;
  }): Promise<
    Array<RepossessionCase & { loan: { number: string; customerId: string } }>
  > {
    return this.prisma.repossessionCase.findMany({
      where: { status: filter?.status, loanId: filter?.loanId },
      include: { loan: { select: { number: true, customerId: true } } },
      orderBy: { identifiedAt: "desc" },
      take: filter?.take ?? 200,
    });
  }

  async findById(id: string): Promise<RepossessionCase | null> {
    return this.prisma.repossessionCase.findUnique({ where: { id } });
  }

  async findActiveForLoan(loanId: string): Promise<RepossessionCase | null> {
    return this.prisma.repossessionCase.findUnique({ where: { loanId } });
  }

  // ── Approval chain ───────────────────────────────────────────────────

  async bmApprove(input: ApprovalInput): Promise<RepossessionCase> {
    return this.transition(input.caseId, "IDENTIFIED", "BM_APPROVED", {
      bmApprovedAt: new Date(),
      // Prisma's UpdateInput excludes the raw FK column when a relation is
      // declared on it (`bmApprovedBy`). Use the relation accessor instead.
      bmApprovedBy: { connect: { id: input.approvedById } },
      bmApprovalNote: input.note,
    });
  }

  async creditHeadApprove(input: ApprovalInput): Promise<RepossessionCase> {
    return this.transition(
      input.caseId,
      "BM_APPROVED",
      "CREDIT_HEAD_APPROVED",
      {
        creditHeadApprovedAt: new Date(),
        creditHeadApprovedBy: { connect: { id: input.approvedById } },
        creditHeadApprovalNote: input.note,
      },
    );
  }

  async legalApprove(input: ApprovalInput): Promise<RepossessionCase> {
    return this.transition(
      input.caseId,
      "CREDIT_HEAD_APPROVED",
      "LEGAL_APPROVED",
      {
        legalApprovedAt: new Date(),
        legalApprovedBy: { connect: { id: input.approvedById } },
        legalApprovalNote: input.note,
      },
    );
  }

  // ── Field execution ──────────────────────────────────────────────────

  async assignAgent(input: AssignAgentInput): Promise<RepossessionCase> {
    return this.transition(input.caseId, "LEGAL_APPROVED", "AGENT_ASSIGNED", {
      agentName: input.agentName,
      agentContact: input.agentContact,
      agentAssignedAt: new Date(),
      agentAssignedBy: { connect: { id: input.assignedById } },
    });
  }

  async recover(input: RecoverInput): Promise<RepossessionCase> {
    return this.transition(input.caseId, "AGENT_ASSIGNED", "RECOVERED", {
      recoveredAt: new Date(),
      recoveredBy: { connect: { id: input.recoveredById } },
      vehicleCondition: input.vehicleCondition.slice(0, 500),
      vehicleMileage: input.vehicleMileage,
      vehiclePhotos: (input.vehiclePhotos ?? []).join(","),
      storageLocation: input.storageLocation,
      outstandingAtRecovery: input.outstandingAtRecovery,
    });
  }

  /**
   * Auction settlement — applies proceeds, books deficiency, transitions
   * to AUCTIONED, then CLOSED. Loan status is also flipped to CLOSED.
   */
  async auction(input: AuctionInput): Promise<{
    case: RepossessionCase;
    journalEntryId: string;
    deficiency: number;
    surplus: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.repossessionCase.findUnique({
        where: { id: input.caseId },
        include: { loan: { select: { number: true } } },
      });
      if (!c) throw new Error("Repossession case not found");
      if (c.status !== "RECOVERED") {
        throw new Error(`Cannot auction from status ${c.status}`);
      }
      const outstanding = Number(c.outstandingAtRecovery ?? 0);
      if (outstanding <= 0) {
        throw new Error("Outstanding-at-recovery must be > 0 to auction");
      }

      const proceeds = round2(input.auctionProceeds);
      const deficiency = round2(Math.max(0, outstanding - proceeds));
      const surplus = round2(Math.max(0, proceeds - outstanding));

      // Post the auction settlement entry. Lazy-import to keep the
      // accounting lib out of @loan/db's cold path.
      const { repossessionAuctionEntry } = await import("@loan/accounting");
      const entry = repossessionAuctionEntry({
        caseId: c.id,
        loanId: c.loanId,
        loanNumber: c.loan.number,
        outstandingAtRecovery: outstanding,
        auctionProceeds: proceeds,
        auctionedOn: new Date(),
      });
      const result = await this.accounting.postIfAbsent(entry, {
        postedById: input.auctionedById,
        tx,
      });

      // Close the loan + mark schedule paid (any remaining principal is
      // either covered by proceeds or charged to bad debt above).
      const open = await tx.loanSchedule.findMany({
        where: { loanId: c.loanId, paidInFullAt: null },
      });
      for (const inst of open) {
        await tx.loanSchedule.update({
          where: { id: inst.id },
          data: {
            paidInFullAt: new Date(),
            principalPaid: inst.principalDue,
            interestPaid: inst.interestDue,
          },
        });
      }
      await tx.loanApplication.update({
        where: { id: c.loanId },
        data: { status: "CLOSED", closedAt: new Date() },
      });

      const updated = await tx.repossessionCase.update({
        where: { id: c.id },
        data: {
          status: "CLOSED",
          auctionedAt: new Date(),
          auctionedById: input.auctionedById,
          auctionMethod: input.auctionMethod.slice(0, 40),
          auctionProceeds: proceeds,
          deficiency,
          journalEntryId: result.entry.id,
        },
      });

      return {
        case: updated,
        journalEntryId: result.entry.id,
        deficiency,
        surplus,
      };
    });
  }

  /**
   * Cancel an in-flight case. Allowed from any state up to RECOVERED;
   * once AUCTIONED/CLOSED the GL is committed and no rollback is supported.
   */
  async cancel(input: CancelInput): Promise<RepossessionCase> {
    const c = await this.prisma.repossessionCase.findUnique({
      where: { id: input.caseId },
    });
    if (!c) throw new Error("Repossession case not found");
    if (
      c.status === "AUCTIONED" ||
      c.status === "CLOSED" ||
      c.status === "CANCELLED"
    ) {
      throw new Error(`Cannot cancel from status ${c.status}`);
    }
    return this.prisma.repossessionCase.update({
      where: { id: c.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: input.cancelledById,
        cancellationReason: input.reason.slice(0, 500),
      },
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private async transition(
    caseId: string,
    fromStatus: RepossessionStatus,
    toStatus: RepossessionStatus,
    extra: Prisma.RepossessionCaseUpdateInput,
  ): Promise<RepossessionCase> {
    const c = await this.prisma.repossessionCase.findUnique({
      where: { id: caseId },
    });
    if (!c) throw new Error("Repossession case not found");
    if (c.status !== fromStatus) {
      throw new Error(
        `Cannot advance from ${c.status} (expected ${fromStatus})`,
      );
    }
    return this.prisma.repossessionCase.update({
      where: { id: c.id },
      data: { ...extra, status: toStatus },
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
