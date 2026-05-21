/**
 * Annual / renewable document tracker — FRD §3.8.
 *
 * For loan products that require insurance / RPT / OR-CR that must be
 * renewed annually, we track each submission with its `effectiveFrom`
 * and `expiresAt` so a scheduled job can warn the borrower 30 days
 * before lapse and again at expiry. Status is recomputed on read +
 * persisted on the daily refresh job (so dashboards can filter cheaply
 * without re-deriving from `expiresAt` every query).
 */

import type {
  AnnualDocument,
  AnnualDocumentStatus,
  AnnualDocumentType,
  PrismaClient,
} from "@prisma/client";

const EXPIRING_WINDOW_DAYS = 30;

export interface AnnualDocumentInput {
  loanId: string;
  type: AnnualDocumentType;
  name: string;
  documentUrl?: string;
  effectiveFrom: Date;
  expiresAt: Date;
  notes?: string;
  submittedById: string;
}

export class AnnualDocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Add a new renewable doc to a loan. */
  async create(input: AnnualDocumentInput): Promise<AnnualDocument> {
    if (input.expiresAt <= input.effectiveFrom) {
      throw new Error("expiresAt must be after effectiveFrom");
    }
    const status = computeStatus(input.expiresAt, new Date());
    return this.prisma.annualDocument.create({
      data: {
        loanId: input.loanId,
        type: input.type,
        name: input.name.slice(0, 200),
        documentUrl: input.documentUrl,
        effectiveFrom: input.effectiveFrom,
        expiresAt: input.expiresAt,
        notes: input.notes,
        submittedById: input.submittedById,
        status,
      },
    });
  }

  async listForLoan(loanId: string): Promise<AnnualDocument[]> {
    return this.prisma.annualDocument.findMany({
      where: { loanId },
      orderBy: { expiresAt: "asc" },
    });
  }

  async remove(id: string): Promise<void> {
    await this.prisma.annualDocument.delete({ where: { id } });
  }

  /**
   * All docs that are either within `withinDays` of expiry OR already past.
   * Powers both the dashboard "expiring soon" page and the daily reminder
   * scheduled job. Joined to loan + customer for the UI.
   */
  async listExpiring(
    withinDays = EXPIRING_WINDOW_DAYS,
    asOf: Date = new Date(),
  ): Promise<
    Array<
      AnnualDocument & {
        loan: { number: string; customerId: string };
      }
    >
  > {
    const cutoff = new Date(asOf);
    cutoff.setDate(cutoff.getDate() + withinDays);
    return this.prisma.annualDocument.findMany({
      where: { expiresAt: { lte: cutoff } },
      include: { loan: { select: { number: true, customerId: true } } },
      orderBy: { expiresAt: "asc" },
    });
  }

  /**
   * Recompute & persist `status` for every row. Cheap nightly maintenance —
   * the dashboard can then filter by status without recomputing per query.
   * Returns counts so the job log is useful.
   */
  async refreshStatuses(asOf: Date = new Date()): Promise<{
    valid: number;
    expiringSoon: number;
    expired: number;
  }> {
    const docs = await this.prisma.annualDocument.findMany({
      select: { id: true, expiresAt: true, status: true },
    });
    let valid = 0;
    let expiringSoon = 0;
    let expired = 0;
    for (const d of docs) {
      const next = computeStatus(d.expiresAt, asOf);
      if (next === "VALID") valid++;
      else if (next === "EXPIRING_SOON") expiringSoon++;
      else expired++;
      if (next !== d.status) {
        await this.prisma.annualDocument.update({
          where: { id: d.id },
          data: { status: next },
        });
      }
    }
    return { valid, expiringSoon, expired };
  }

  /**
   * Mark a reminder as sent (called by the notification job). Idempotent —
   * the caller decides via `lastReminderAt` whether enough time has passed.
   */
  async markReminderSent(id: string, at: Date = new Date()): Promise<void> {
    await this.prisma.annualDocument.update({
      where: { id },
      data: {
        lastReminderAt: at,
        reminderCount: { increment: 1 },
      },
    });
  }
}

/** Pure helper — exported for tests. */
export function computeStatus(
  expiresAt: Date,
  asOf: Date,
): AnnualDocumentStatus {
  const ms = expiresAt.getTime() - asOf.getTime();
  const day = 86_400_000;
  if (ms <= 0) return "EXPIRED";
  if (ms <= EXPIRING_WINDOW_DAYS * day) return "EXPIRING_SOON";
  return "VALID";
}
