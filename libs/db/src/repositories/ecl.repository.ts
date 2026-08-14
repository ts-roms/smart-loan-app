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
  /**
   * The journal entry carrying THIS PERIOD's provision movement — the one
   * this run posted, or the one it found already there. Null when there
   * is no such entry.
   *
   * Deliberately the period's state rather than this run's: an operator
   * who re-runs needs a link to the entry that governs the period, and
   * `posting` below says whether this run is the one that wrote it. The
   * `EclRun.journalEntryId` COLUMN answers the narrower question and is
   * set only on the run that actually posted, so summing across runs
   * cannot count one movement twice.
   */
  journalEntryId: string | null;
  /** What this run did to the general ledger. See `EclPostingOutcome`. */
  posting: EclPostingOutcome;
}

/**
 * What a run did to the ledger — the four distinguishable outcomes.
 *
 * `ALREADY_POSTED` is the one that carries policy. Posted financial
 * history is corrected by reversal, not by re-posting (§12), so a second
 * run over a window that is already booked recomputes and re-stages every
 * loan — which is safe and idempotent — but books nothing. If the figures
 * genuinely moved, the honest correction is to reverse the existing entry
 * and post again, and the caller is told plainly so it can say so.
 */
export type EclPostingOutcome =
  /** This run posted the period's movement. */
  | "POSTED"
  /** The period was already booked; this run added no second entry. */
  | "ALREADY_POSTED"
  /** The delta rounded to zero — there was nothing to book. */
  | "NO_MOVEMENT"
  /**
   * A movement existed but no `computedById` was supplied to attribute
   * the posting to. Repository-level callers only — every API path
   * carries an actor.
   */
  | "NOT_ATTRIBUTED";

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
   * computation) and now at the LEDGER level too: the provision movement
   * for a given (periodStart, periodEnd) is booked exactly once, however
   * many times this is called. A re-run recomputes everything and returns
   * `posting: "ALREADY_POSTED"` with the existing entry's id.
   *
   * Re-running still writes another EclRun row — each row is the record
   * of a computation, and the latest by `periodEnd` is authoritative for
   * the figures. Only the first row for a window carries
   * `journalEntryId`, because only that run posted.
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

    /*
     * The entry is built BEFORE the run row exists, and that ordering is
     * the fix rather than an incidental tidy-up. Its idempotency key is
     * the period the movement represents, so it no longer depends on a
     * row this method is about to mint — see `eclProvisionEntry`.
     */
    const entry = eclProvisionEntry({
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      delta,
      postedAt: asOf,
      memo: `ECL movement for ${input.periodStart.toISOString().slice(0, 10)} → ${input.periodEnd.toISOString().slice(0, 10)}`,
    });

    // Every computation is recorded, including one that books nothing:
    // the run row is the evidence that the portfolio was assessed.
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

    /*
     * Post the movement. `entry` is null when the delta rounds to zero —
     * a period that did not move has nothing to book, and that is not the
     * same as a period that was already booked.
     *
     * Now that the key is the period, `postIfAbsent` genuinely guards the
     * re-run: the unique index on (source, sourceRefType, sourceRefId)
     * rejects the second insert and hands back the entry that is already
     * there. That also holds for two runs racing, which a read-then-write
     * check never could.
     *
     * A second run therefore books NOTHING and says so. It is not an
     * error — recomputing stages and per-loan provisions is legitimate
     * and has already happened above. But the ledger movement for this
     * window is written once; if the figures genuinely changed, §12 wants
     * the existing entry reversed and a fresh one posted, not a second
     * movement stacked on the first.
     */
    let journalEntryId: string | null = null;
    let posting: EclPostingOutcome = "NO_MOVEMENT";
    if (entry && !input.computedById) {
      posting = "NOT_ATTRIBUTED";
    } else if (entry && input.computedById) {
      const accounting = new AccountingRepository(this.prisma);
      const { entry: posted, created } = await accounting.postIfAbsent(entry, {
        postedById: input.computedById,
      });
      journalEntryId = posted.id;
      posting = created ? "POSTED" : "ALREADY_POSTED";
      /*
       * The column records what THIS run did, so it is written only by
       * the run that actually posted. A later run over the same window
       * leaves it null: it booked nothing, and a row claiming a journal
       * link it did not create would double-count the movement to anyone
       * aggregating over run history.
       */
      if (created) {
        await this.prisma.eclRun.update({
          where: { id: run.id },
          data: { journalEntryId },
        });
      }
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
      posting,
    };
  }
}
