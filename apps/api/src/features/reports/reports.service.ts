import { type DorsiRepository, type PrismaClient } from "@loan/db";

import type { ReportType } from "./schemas.js";

/**
 * Compliance reports — FRD audit requirements (§3.1.5, §3.2.3, §3.3.7,
 * §3.5.8, §3.7.7, §3.8.6, §3.9.4, §3.10.6).
 *
 * One service, six report builders. The service owns:
 *   • date-range default rules (defaults to last 30 days)
 *   • per-report row shaping
 *   • the dispatch from type-string → builder
 *
 * The HTTP layer handles JSON/CSV formatting + Content-Disposition.
 * The "filename stamp" is also produced here because it needs the
 * resolved `from`/`to` dates that the service computed.
 */

export interface BuildOptions {
  /** Inclusive lower bound; defaults to one month ago. */
  from?: Date;
  /** Inclusive upper bound; defaults to now. */
  to?: Date;
}

/** What the controller needs to ship a download response. */
export interface ReportBundle {
  filename: string;
  rows: Array<Record<string, unknown>>;
}

export class ReportsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly dorsi: DorsiRepository,
  ) {}

  async generate(type: ReportType, opts: BuildOptions): Promise<ReportBundle> {
    const { from, to } = resolveRange(opts);
    const dated = (label: string) => `${label}-${stamp(from, to)}`;
    const today = (label: string) => `${label}-${stamp()}`;

    switch (type) {
      case "dorsi-utilization":
        return {
          filename: today("dorsi-utilization"),
          rows: await this.dorsiUtilization(),
        };
      case "penalty-waivers":
        return {
          filename: dated("penalty-waivers"),
          rows: await this.penaltyWaivers(from, to),
        };
      case "demand-letters":
        return {
          filename: dated("demand-letters"),
          rows: await this.demandLetters(from, to),
        };
      case "repossession-cases":
        return {
          filename: dated("repossession-cases"),
          rows: await this.repossessionCases(from, to),
        };
      case "annual-docs":
        return {
          filename: today("annual-docs"),
          rows: await this.annualDocs(),
        };
      case "ecl-movement":
        return {
          filename: dated("ecl-movement"),
          rows: await this.eclMovement(from, to),
        };
    }
  }

  // ─── builders ─────────────────────────────────────────────────────

  private async dorsiUtilization() {
    const u = await this.dorsi.utilization();
    return u.perBorrower.map((b) => ({
      customerId: b.customerId,
      customerName: b.customerName,
      category: b.category,
      outstanding: b.outstanding,
      individualCap: u.individualCap,
      utilizationPct: round4(b.utilizationPct),
      aggregateOutstanding: u.aggregateOutstanding,
      aggregateCap: u.aggregateCap,
      aggregateUtilizationPct: round4(u.aggregateUtilizationPct),
      companyTotalEquity: u.companyTotalEquity,
    }));
  }

  private async penaltyWaivers(from: Date, to: Date) {
    const rows = await this.prisma.penaltyWaiver.findMany({
      where: { waivedAt: { gte: from, lte: to } },
      include: {
        loan: { select: { number: true, customerId: true } },
        waivedBy: { select: { name: true, email: true } },
      },
      orderBy: { waivedAt: "desc" },
    });
    return rows.map((w) => ({
      waiverId: w.id,
      loanNumber: w.loan.number,
      customerId: w.loan.customerId,
      waivedAt: w.waivedAt.toISOString(),
      originalPenalty: Number(w.originalPenalty),
      waivedAmount: Number(w.waivedAmount),
      negotiatedPenalty: Number(w.negotiatedPenalty),
      reason: w.reason,
      waivedBy: w.waivedBy.name,
      waivedByEmail: w.waivedBy.email,
      journalEntryId: w.journalEntryId,
    }));
  }

  private async demandLetters(from: Date, to: Date) {
    const rows = await this.prisma.demandLetter.findMany({
      where: { draftedAt: { gte: from, lte: to } },
      include: {
        loan: { select: { number: true, customerId: true } },
        draftedBy: { select: { name: true } },
        approvedBy: { select: { name: true } },
        dispatchedBy: { select: { name: true } },
      },
      orderBy: { draftedAt: "desc" },
    });
    return rows.map((l) => ({
      letterId: l.id,
      loanNumber: l.loan.number,
      customerId: l.loan.customerId,
      stage: l.stage,
      status: l.status,
      daysOverdue: l.daysOverdue,
      totalOwed: Number(l.totalOwed),
      paymentDeadline: l.paymentDeadline.toISOString().slice(0, 10),
      draftedAt: l.draftedAt.toISOString(),
      draftedBy: l.draftedBy.name,
      approvedAt: l.approvedAt?.toISOString() ?? null,
      approvedBy: l.approvedBy?.name ?? null,
      dispatchedAt: l.dispatchedAt?.toISOString() ?? null,
      dispatchedBy: l.dispatchedBy?.name ?? null,
      dispatchChannel: l.dispatchChannel ?? null,
      closedReason: l.closedReason ?? null,
    }));
  }

  private async repossessionCases(from: Date, to: Date) {
    const rows = await this.prisma.repossessionCase.findMany({
      where: { identifiedAt: { gte: from, lte: to } },
      include: { loan: { select: { number: true, customerId: true } } },
      orderBy: { identifiedAt: "desc" },
    });
    return rows.map((c) => ({
      caseId: c.id,
      loanNumber: c.loan.number,
      customerId: c.loan.customerId,
      status: c.status,
      identifiedAt: c.identifiedAt.toISOString(),
      reason: c.reason,
      bmApprovedAt: c.bmApprovedAt?.toISOString() ?? null,
      creditHeadApprovedAt: c.creditHeadApprovedAt?.toISOString() ?? null,
      legalApprovedAt: c.legalApprovedAt?.toISOString() ?? null,
      recoveredAt: c.recoveredAt?.toISOString() ?? null,
      auctionedAt: c.auctionedAt?.toISOString() ?? null,
      outstandingAtRecovery: c.outstandingAtRecovery
        ? Number(c.outstandingAtRecovery)
        : null,
      auctionProceeds: c.auctionProceeds ? Number(c.auctionProceeds) : null,
      deficiency: c.deficiency ? Number(c.deficiency) : null,
    }));
  }

  private async annualDocs() {
    const docs = await this.prisma.annualDocument.findMany({
      include: { loan: { select: { number: true, customerId: true } } },
    });
    const byStatus = { VALID: 0, EXPIRING_SOON: 0, EXPIRED: 0 };
    for (const d of docs) byStatus[d.status] += 1;
    return [
      {
        asOf: new Date().toISOString(),
        totalDocs: docs.length,
        valid: byStatus.VALID,
        expiringSoon: byStatus.EXPIRING_SOON,
        expired: byStatus.EXPIRED,
        compliancePct: docs.length ? round4(byStatus.VALID / docs.length) : 0,
      },
      ...docs.map((d) => ({
        docId: d.id,
        loanNumber: d.loan.number,
        customerId: d.loan.customerId,
        type: d.type,
        name: d.name,
        status: d.status,
        effectiveFrom: d.effectiveFrom.toISOString().slice(0, 10),
        expiresAt: d.expiresAt.toISOString().slice(0, 10),
        reminderCount: d.reminderCount,
      })),
    ];
  }

  private async eclMovement(from: Date, to: Date) {
    const runs = await this.prisma.eclRun.findMany({
      where: { asOf: { gte: from, lte: to } },
      orderBy: { asOf: "asc" },
    });
    // Delta = period-over-period change in totalEcl. The EclRun row
    // itself doesn't carry a stored delta — we derive it from the
    // previous run in the sorted sequence so the report stays correct
    // if a run is later back-dated or deleted.
    let previousTotalEcl = 0;
    return runs.map((r) => {
      const totalEcl = Number(r.totalEcl);
      const delta = totalEcl - previousTotalEcl;
      previousTotalEcl = totalEcl;
      return {
        runId: r.id,
        asOf: r.asOf.toISOString().slice(0, 10),
        periodStart: r.periodStart.toISOString().slice(0, 10),
        periodEnd: r.periodEnd.toISOString().slice(0, 10),
        totalEad: Number(r.totalEad),
        stage1Ecl: Number(r.stage1Ecl),
        stage1Count: r.stage1Count,
        stage2Ecl: Number(r.stage2Ecl),
        stage2Count: r.stage2Count,
        stage3Ecl: Number(r.stage3Ecl),
        stage3Count: r.stage3Count,
        totalEcl,
        delta,
        journalEntryId: r.journalEntryId,
      };
    });
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function resolveRange(opts: BuildOptions) {
  const from = opts.from ?? oneMonthAgo();
  const to = opts.to ?? new Date();
  return { from, to };
}

function oneMonthAgo(): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d;
}

function stamp(from?: Date, to?: Date): string {
  const today = new Date().toISOString().slice(0, 10);
  if (!from || !to) return today;
  return `${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
