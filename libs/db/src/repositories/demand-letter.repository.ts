/**
 * Demand Letter repository.
 *
 * Workflow:
 *   1. `identifyCandidates(stage)` returns loans overdue past the stage's
 *      threshold that don't already have an active letter at this stage.
 *   2. `draftBatch(loanIds, stage, by)` snapshots the financials per loan
 *      and writes DRAFTED rows. The body is rendered from a template.
 *   3. `dispatch(id, channel)` flips DRAFTED -> DISPATCHED and fires the
 *      DEMAND_LETTER_DISPATCHED notification.
 *   4. `close(id, status)` marks RESPONDED (paid) or WAIVED (skip).
 *
 * Amounts are snapshotted at draft time so the letter remains faithful
 * even if the borrower part-pays before dispatch.
 */

import type {
  DemandLetter,
  DemandLetterStage,
  DemandLetterStatus,
  PrismaClient,
} from "@prisma/client";

const STAGE_THRESHOLD_DAYS: Record<DemandLetterStage, number> = {
  FIRST: 60,
  FINAL: 90,
  ATTORNEY_FIRST: 120,
  ATTORNEY_FINAL: 150,
};

/** How long after a letter at stage X before we'd consider another at X. */
const STAGE_COOLDOWN_DAYS = 30;

const dayMs = 86_400_000;

export interface DemandCandidate {
  loanId: string;
  loanNumber: string;
  customerId: string;
  customerName: string;
  email: string | null;
  phone: string;
  principalOwed: number;
  interestOwed: number;
  penaltiesOwed: number;
  totalOwed: number;
  daysOverdue: number;
  /// Id of the most recent letter at this stage, or null.
  lastLetterAtStageId: string | null;
  lastLetterAtStageAt: Date | null;
}

export interface DraftBatchInput {
  loanIds: string[];
  stage: DemandLetterStage;
  /// Policy: 7–15 days from issuance.
  paymentDeadlineDays?: number;
  draftedById: string;
}

export interface DemandLetterDispatchInput {
  channel: string;
  ref?: string;
  dispatchedById: string;
}

export interface CloseInput {
  status: "RESPONDED" | "WAIVED";
  reason: string;
  closedById: string;
}

export class DemandLetterRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Loans eligible for a demand letter at `stage`. Joined with customer
   * + snapshot computation done in JS to keep the SQL portable.
   */
  async identifyCandidates(
    stage: DemandLetterStage,
    asOf: Date = new Date(),
  ): Promise<DemandCandidate[]> {
    const threshold = STAGE_THRESHOLD_DAYS[stage];
    const cutoffDate = new Date(asOf.getTime() - threshold * dayMs);
    const cooldownDate = new Date(asOf.getTime() - STAGE_COOLDOWN_DAYS * dayMs);

    // All loans with at least one open installment older than the threshold.
    const rows = await this.prisma.loanApplication.findMany({
      where: {
        status: { in: ["ACTIVE", "DISBURSED", "DEFAULTED"] },
        schedule: {
          some: { paidInFullAt: null, dueDate: { lt: cutoffDate } },
        },
      },
      include: {
        customer: true,
        schedule: { where: { paidInFullAt: null } },
        demandLetters: {
          where: { stage },
          orderBy: { draftedAt: "desc" },
          take: 1,
        },
      },
    });

    return rows
      .filter((l) => {
        // Skip if there's already an active (DRAFTED/DISPATCHED) letter
        // at this stage, OR a closed one within the cooldown window.
        const recent = l.demandLetters[0];
        if (!recent) return true;
        if (recent.status === "DRAFTED" || recent.status === "DISPATCHED")
          return false;
        return recent.draftedAt < cooldownDate;
      })
      .map((l) => {
        const earliest = l.schedule.reduce<Date | null>((min, s) => {
          if (!min || s.dueDate < min) return s.dueDate;
          return min;
        }, null);
        const daysOverdue = earliest
          ? Math.floor((asOf.getTime() - earliest.getTime()) / dayMs)
          : 0;

        const principalOwed = l.schedule.reduce(
          (s, x) => s + (Number(x.principalDue) - Number(x.principalPaid)),
          0,
        );
        const interestOwed = l.schedule
          .filter((s) => s.dueDate < asOf)
          .reduce((s, x) => s + Number(x.interestDue), 0);

        // We don't snapshot per-installment penalty here; total accrued
        // penalty is computed at draft time via LoanRepository when we
        // actually write the row. For the candidate screen we use 0 to
        // keep the listing query cheap.
        const penaltiesOwed = 0;
        const totalOwed = principalOwed + interestOwed + penaltiesOwed;

        return {
          loanId: l.id,
          loanNumber: l.number,
          customerId: l.customer.id,
          customerName: `${l.customer.firstName} ${l.customer.lastName}`,
          email: l.customer.email,
          phone: l.customer.phone,
          principalOwed: round2(principalOwed),
          interestOwed: round2(interestOwed),
          penaltiesOwed,
          totalOwed: round2(totalOwed),
          daysOverdue,
          lastLetterAtStageId: l.demandLetters[0]?.id ?? null,
          lastLetterAtStageAt: l.demandLetters[0]?.draftedAt ?? null,
        };
      })
      .sort((a, b) => b.daysOverdue - a.daysOverdue);
  }

  /**
   * Create DRAFTED letter rows for each loan id. Each row's body is
   * rendered from the standard template + snapshot amounts. Returns the
   * created rows.
   */
  async draftBatch(
    input: DraftBatchInput,
    accruedPenaltiesFor: (loanId: string) => Promise<number>,
  ): Promise<DemandLetter[]> {
    const deadlineDays = input.paymentDeadlineDays ?? 10;
    const asOf = new Date();
    const candidates = await this.identifyCandidates(input.stage, asOf);
    const byId = new Map(candidates.map((c) => [c.loanId, c]));

    const created: DemandLetter[] = [];
    for (const loanId of input.loanIds) {
      const c = byId.get(loanId);
      if (!c) continue; // silently skip — the candidate set changed under us

      // Snapshot the *current* accrued penalty (not the value at the time
      // the candidates list was computed).
      const penalty = await accruedPenaltiesFor(loanId);
      const totalOwed = round2(c.principalOwed + c.interestOwed + penalty);
      const deadline = new Date(asOf.getTime() + deadlineDays * dayMs);

      const body = renderBody({
        customerName: c.customerName,
        loanNumber: c.loanNumber,
        stage: input.stage,
        principalOwed: c.principalOwed,
        interestOwed: c.interestOwed,
        penaltiesOwed: penalty,
        totalOwed,
        paymentDeadline: deadline,
      });

      const row = await this.prisma.demandLetter.create({
        data: {
          loanId: c.loanId,
          stage: input.stage,
          status: "DRAFTED",
          principalOwed: c.principalOwed,
          interestOwed: c.interestOwed,
          penaltiesOwed: penalty,
          totalOwed,
          daysOverdue: c.daysOverdue,
          paymentDeadline: deadline,
          body,
          draftedById: input.draftedById,
        },
      });
      created.push(row);
    }
    return created;
  }

  async list(filter?: {
    stage?: DemandLetterStage;
    status?: DemandLetterStatus;
    loanId?: string;
    take?: number;
  }): Promise<
    Array<DemandLetter & { loan: { number: string; customerId: string } }>
  > {
    return this.prisma.demandLetter.findMany({
      where: {
        stage: filter?.stage,
        status: filter?.status,
        loanId: filter?.loanId,
      },
      include: { loan: { select: { number: true, customerId: true } } },
      orderBy: { draftedAt: "desc" },
      take: filter?.take ?? 200,
    });
  }

  async findById(id: string): Promise<DemandLetter | null> {
    return this.prisma.demandLetter.findUnique({ where: { id } });
  }

  /**
   * Approve a drafted letter escalation matrix. The route
   * layer gates this on the right signatory permission:
   *   - FIRST / FINAL          → collections.dl_approve_company
   *   - ATTORNEY_FIRST / FINAL → collections.dl_approve_legal
   */
  async approve(
    id: string,
    input: { approvedById: string; note?: string },
  ): Promise<DemandLetter> {
    const letter = await this.prisma.demandLetter.findUnique({ where: { id } });
    if (!letter) throw new Error("Demand letter not found");
    if (letter.status !== "DRAFTED") {
      throw new Error(`Cannot approve from status ${letter.status}`);
    }
    return this.prisma.demandLetter.update({
      where: { id },
      data: {
        status: "APPROVED",
        approvedAt: new Date(),
        approvedById: input.approvedById,
        approvalNote: input.note?.slice(0, 500),
      },
    });
  }

  /** Mark APPROVED -> DISPATCHED. The dispatcher fires the notification. */
  async dispatch(
    id: string,
    input: DemandLetterDispatchInput,
  ): Promise<DemandLetter> {
    const letter = await this.prisma.demandLetter.findUnique({ where: { id } });
    if (!letter) throw new Error("Demand letter not found");
    if (letter.status !== "APPROVED") {
      throw new Error(
        `Cannot dispatch from status ${letter.status} — must be APPROVED first`,
      );
    }
    return this.prisma.demandLetter.update({
      where: { id },
      data: {
        status: "DISPATCHED",
        dispatchedAt: new Date(),
        dispatchedById: input.dispatchedById,
        dispatchChannel: input.channel,
        dispatchRef: input.ref,
      },
    });
  }

  /**
   * Close as RESPONDED (borrower paid / arrangement) or WAIVED (skip).
   * Both are terminal states.
   */
  async close(id: string, input: CloseInput): Promise<DemandLetter> {
    const letter = await this.prisma.demandLetter.findUnique({ where: { id } });
    if (!letter) throw new Error("Demand letter not found");
    if (letter.status === "RESPONDED" || letter.status === "WAIVED") {
      throw new Error("Letter already closed");
    }
    return this.prisma.demandLetter.update({
      where: { id },
      data: {
        status: input.status,
        closedAt: new Date(),
        closedById: input.closedById,
        closedReason: input.reason.slice(0, 500),
      },
    });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const STAGE_TITLE: Record<DemandLetterStage, string> = {
  FIRST: "DEMAND FOR PAYMENT",
  FINAL: "FINAL DEMAND FOR PAYMENT",
  ATTORNEY_FIRST: "ATTORNEY DEMAND FOR PAYMENT",
  ATTORNEY_FINAL: "FINAL ATTORNEY DEMAND FOR PAYMENT",
};

/**
 * Render the letter body from the template. Plain text — the
 * downstream PDF renderer can wrap it in firm letterhead later.
 *
 * Pure function — exported for tests.
 */
export function renderBody(args: {
  customerName: string;
  loanNumber: string;
  stage: DemandLetterStage;
  principalOwed: number;
  interestOwed: number;
  penaltiesOwed: number;
  totalOwed: number;
  paymentDeadline: Date;
}): string {
  const fmt = (n: number) =>
    `PHP ${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = args.paymentDeadline.toISOString().slice(0, 10);
  const title = STAGE_TITLE[args.stage];
  return [
    `Subject: ${title}`,
    "",
    `Dear ${args.customerName},`,
    "",
    `This is to formally notify you that your account (Loan ${args.loanNumber}) is past due despite previous reminders.`,
    "",
    "As of today, your outstanding balance is:",
    `  Principal Amount:   ${fmt(args.principalOwed)}`,
    `  Accrued Interest:   ${fmt(args.interestOwed)}`,
    `  Penalties / Late Charges: ${fmt(args.penaltiesOwed)}`,
    `  Total Amount Due:   ${fmt(args.totalOwed)}`,
    "",
    `We demand full payment of the above amount by ${date}. Failure to comply will compel us to take appropriate actions, which may include:`,
    "  - Endorsement for legal collection",
    "  - Filing of a formal complaint",
    "  - Additional legal and administrative costs that may be charged to you",
    "",
    "We would still prefer to resolve this matter without further escalation. Kindly settle your account or contact us to discuss any possible arrangements.",
    "",
    args.stage === "FINAL" || args.stage === "ATTORNEY_FINAL"
      ? "Please treat this as our FINAL DEMAND."
      : "Please treat this as our formal demand.",
    "",
    "Thank you for your immediate attention.",
    "",
    "Respectfully yours,",
    "United Financing Corporation",
  ].join("\n");
}
