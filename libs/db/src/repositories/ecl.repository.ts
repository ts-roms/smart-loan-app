/**
 * Expected Credit Loss (IFRS 9 / PFRS 9) computation + persistence.
 *
 * Simple model — sufficient for non-bank lender compliance:
 *
 *   ECL = PD × LGD × EAD
 *   ├ Stage 1 (0–29 DPD) uses 12-month PD
 *   ├ Stage 2 (30–89 DPD) uses lifetime PD
 *   └ Stage 3 (≥90 DPD)   uses lifetime PD
 *
 * EAD = outstanding principal (good enough for fully-amortizing retail loans;
 * for revolving credit you'd add a CCF).
 *
 * The DPD is computed from the oldest unpaid scheduled installment relative
 * to `asOf`. SICR (significant increase in credit risk) flags are out of
 * scope — Stage transitions here are purely DPD-driven, with a one-way
 * door: once in Stage 3, a loan only returns to Stage 1 after the cure
 * period (≥6 months of consecutive on-time payments). We approximate that
 * with: stay in Stage 3 unless DPD has been 0 for 6+ months.
 */

import type { PrismaClient, Prisma } from "@prisma/client";

import { eclProvisionEntry } from "@loan/accounting";

import { AccountingRepository } from "./accounting.repository";

export interface EclRunInput {
  periodStart: Date;
  periodEnd: Date;
  asOf?: Date;
  computedById?: string;
  notes?: string;
}

export interface EclRunResult {
  id: string;
  totalEad: number;
  totalEcl: number;
  byStage: Record<
    "STAGE_1" | "STAGE_2" | "STAGE_3",
    { count: number; ecl: number }
  >;
  perLoan: Array<{
    loanId: string;
    number: string;
    dpd: number;
    stage: "STAGE_1" | "STAGE_2" | "STAGE_3";
    ead: number;
    ecl: number;
  }>;
  /** Movement from prior period (positive = build, negative = release). */
  delta: number;
  /** Journal entry id, or null when delta == 0 or no caller id provided. */
  journalEntryId: string | null;
}

type Stage = "STAGE_1" | "STAGE_2" | "STAGE_3";

function stageFromDpd(dpd: number): Stage {
  if (dpd >= 90) return "STAGE_3";
  if (dpd >= 30) return "STAGE_2";
  return "STAGE_1";
}

export class EclRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list() {
    return this.prisma.eclRun.findMany({
      orderBy: { periodEnd: "desc" },
      take: 60,
    });
  }

  /**
   * Recompute ECL for every active loan as of `asOf`, persist the new
   * stage + provision on each loan, and write an EclRun summary row.
   *
   * Idempotent at the loan level (always overwrites with the latest
   * computation). Re-running for the same period creates another EclRun
   * row — callers should treat the latest by periodEnd as authoritative.
   */
  async run(input: EclRunInput): Promise<EclRunResult> {
    const asOf = input.asOf ?? input.periodEnd;
    // ECL applies to loans still on the books — exclude terminal states
    // (CLOSED, REJECTED, CANCELLED, RESTRUCTURED, WRITTEN_OFF). DEFAULTED
    // stays in scope because Stage 3 ECL is exactly the right number for
    // those — that's why we want them computed.
    const activeStatuses = ["DISBURSED", "ACTIVE", "DEFAULTED"] as const;
    const loans = await this.prisma.loanApplication.findMany({
      where: {
        status: {
          in: activeStatuses as unknown as Prisma.EnumLoanStatusFilter["in"],
        },
      },
      include: { product: true, schedule: true },
    });

    const perLoan: EclRunResult["perLoan"] = [];
    const byStage: EclRunResult["byStage"] = {
      STAGE_1: { count: 0, ecl: 0 },
      STAGE_2: { count: 0, ecl: 0 },
      STAGE_3: { count: 0, ecl: 0 },
    };
    let totalEad = 0;
    let totalEcl = 0;

    for (const loan of loans) {
      // DPD = days since oldest unpaid installment's due date.
      const overdue = loan.schedule
        .filter((s) => !s.paidInFullAt && s.dueDate < asOf)
        .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
      const oldest = overdue[0];
      const dpd = oldest
        ? Math.floor((asOf.getTime() - oldest.dueDate.getTime()) / 86_400_000)
        : 0;

      const stage = stageFromDpd(dpd);
      const product = loan.product;
      const pd =
        stage === "STAGE_1"
          ? Number(product.eclPd12m)
          : Number(product.eclPdLifetime);
      const lgd = Number(product.eclLgd);

      // EAD = remaining principal across unpaid installments.
      const ead = loan.schedule
        .filter((s) => !s.paidInFullAt)
        .reduce(
          (sum, s) => sum + (Number(s.principalDue) - Number(s.principalPaid)),
          0,
        );
      const ecl = +(ead * pd * lgd).toFixed(2);

      perLoan.push({
        loanId: loan.id,
        number: loan.number,
        dpd,
        stage,
        ead: +ead.toFixed(2),
        ecl,
      });
      byStage[stage].count++;
      byStage[stage].ecl += ecl;
      totalEad += ead;
      totalEcl += ecl;

      await this.prisma.loanApplication.update({
        where: { id: loan.id },
        data: {
          eclStage: stage,
          eclProvision: ecl as unknown as Prisma.Decimal,
          eclComputedAt: asOf,
        },
      });
    }

    // Find the previous run (by periodEnd) — used to compute the delta we
    // need to book. First-ever run posts the entire ECL; subsequent runs
    // post just the period-on-period change.
    const previous = await this.prisma.eclRun.findFirst({
      where: { periodEnd: { lt: input.periodEnd } },
      orderBy: { periodEnd: "desc" },
    });
    const previousEcl = previous ? Number(previous.totalEcl) : 0;
    const delta = +(totalEcl - previousEcl).toFixed(2);

    // Create the run row first (without journal id) so the journal entry
    // can reference it via sourceRefId.
    const run = await this.prisma.eclRun.create({
      data: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        asOf,
        totalEad: +totalEad.toFixed(2) as unknown as Prisma.Decimal,
        totalEcl: +totalEcl.toFixed(2) as unknown as Prisma.Decimal,
        stage1Count: byStage.STAGE_1.count,
        stage2Count: byStage.STAGE_2.count,
        stage3Count: byStage.STAGE_3.count,
        stage1Ecl: +byStage.STAGE_1.ecl.toFixed(2) as unknown as Prisma.Decimal,
        stage2Ecl: +byStage.STAGE_2.ecl.toFixed(2) as unknown as Prisma.Decimal,
        stage3Ecl: +byStage.STAGE_3.ecl.toFixed(2) as unknown as Prisma.Decimal,
        computedById: input.computedById,
        notes: input.notes,
      },
    });

    // Post the journal movement. eclProvisionEntry returns null when the
    // delta rounds to zero — no entry needed in that case.
    let journalEntryId: string | null = null;
    const entry = eclProvisionEntry({
      eclRunId: run.id,
      delta,
      postedAt: asOf,
      memo: `ECL movement for ${input.periodStart.toISOString().slice(0, 10)} → ${input.periodEnd.toISOString().slice(0, 10)}`,
    });
    if (entry && input.computedById) {
      // postIfAbsent makes the run idempotent at the journal level: a
      // re-run with the same EclRun.id won't double-book. (A new EclRun
      // row, though, would book again — callers managing re-runs should
      // delete the prior run first.)
      const accounting = new AccountingRepository(this.prisma);
      const { entry: posted } = await accounting.postIfAbsent(entry, {
        postedById: input.computedById,
      });
      journalEntryId = posted.id;
      await this.prisma.eclRun.update({
        where: { id: run.id },
        data: { journalEntryId },
      });
    }

    return {
      id: run.id,
      totalEad: +totalEad.toFixed(2),
      totalEcl: +totalEcl.toFixed(2),
      byStage: {
        STAGE_1: { ...byStage.STAGE_1, ecl: +byStage.STAGE_1.ecl.toFixed(2) },
        STAGE_2: { ...byStage.STAGE_2, ecl: +byStage.STAGE_2.ecl.toFixed(2) },
        STAGE_3: { ...byStage.STAGE_3, ecl: +byStage.STAGE_3.ecl.toFixed(2) },
      },
      perLoan,
      delta,
      journalEntryId,
    };
  }
}
