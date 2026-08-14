import {
  ACCOUNT_CODES,
  agingBucketFor,
  eclPeriodRef,
  toCentavos,
} from "@loan/accounting";
import {
  type CollectionsRepository,
  type DorsiRepository,
  type PrismaClient,
} from "@loan/db";

import type { ReportType } from "./schemas";

/**
 * Compliance reports — the audit requirements across modules.
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
  /** Area narrowing — only the collections-aging report reads these. */
  province?: string;
  city?: string;
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
    private readonly collections: CollectionsRepository,
  ) {}

  async generate(type: ReportType, opts: BuildOptions): Promise<ReportBundle> {
    const { from, to } = resolveRange(opts);
    const dated = (label: string) => `${label}-${stamp(from, to)}`;
    const today = (label: string) => `${label}-${stamp()}`;

    switch (type) {
      case "collections-aging":
        return {
          filename: today(
            // The area rides in the filename so a folder of month-end
            // downloads stays tellable-apart without opening them.
            ["collections-aging", opts.province?.trim(), opts.city?.trim()]
              .filter(Boolean)
              .join("-")
              .toLowerCase()
              .replace(/\s+/g, "_"),
          ),
          rows: await this.collectionsAging(opts),
        };
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

  /**
   * Delinquency snapshot as of run time — the exportable counterpart of
   * the collections queue, sharing its derivation (overdueQueue) so the
   * report can never disagree with the screen about who is overdue, and
   * `agingBucketFor` so it cannot disagree about how overdue either.
   * The band is emitted as the raw enum rather than a prettier label:
   * a label map here would be a second place that names the bands, and
   * the export is read next to the aging report, which emits the same
   * tokens.
   *
   * Area matching is case-insensitive equality, not substring: the
   * values arrive typed rather than picked from a dropdown, and
   * "Rizal" as a substring would also pull every city with Rizal in
   * its name.
   */
  private async collectionsAging(opts: BuildOptions) {
    const rows = await this.collections.overdueQueue(new Date());
    const wantProvince = opts.province?.trim().toLowerCase();
    const wantCity = opts.city?.trim().toLowerCase();

    return rows
      .filter(
        (r) =>
          (!wantProvince ||
            (r.customerProvince ?? "").toLowerCase() === wantProvince) &&
          (!wantCity || r.customerCity.toLowerCase() === wantCity),
      )
      .map((r) => ({
        loanNumber: r.number,
        customer: r.customerName,
        city: r.customerCity,
        province: r.customerProvince ?? "",
        product: r.productCode,
        status: r.status,
        outstanding: r.outstanding,
        overdueInstallments: r.overdueCount,
        daysOverdue: r.daysOverdue,
        agingBucket: agingBucketFor(r.daysOverdue),
        assignee: r.assignee?.collectorName ?? "UNASSIGNED",
        assignedAt: r.assignee?.assignedAt.toISOString() ?? "",
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

  /**
   * ECL movement — the provision level per assessment, the movement the
   * GENERAL LEDGER actually booked for each period, and the gap between
   * them.
   *
   * ── Why the ledger had to come into this ───────────────────────────
   *
   * This used to derive a movement by subtracting the previous ROW's
   * `totalEcl`, over every `EclRun` in the window, seeded at zero. Both
   * halves of that produced movements the ledger never made.
   *
   * A re-run of an already-posted period recomputes and re-stages but
   * books NOTHING — `ALREADY_POSTED`, by design, because posted history
   * is corrected by reversal and not by layering a second entry (§12).
   * It still writes a run row, so row-to-row subtraction invented a
   * delta for it. And seeding at zero made the earliest row in any range
   * report its entire closing provision as a movement, so the same
   * period moved by different amounts depending on which range you
   * asked for.
   *
   * A report whose numbers cannot be tied to the ledger is worse than no
   * report, because this one is what management reads. So the movement
   * is now READ FROM THE JOURNAL, which is the only record of what was
   * actually booked.
   *
   * ── Why every run is still a row ───────────────────────────────────
   *
   * Reporting only runs that posted was the tempting fix and it is the
   * wrong one: it hides the recomputation. If a re-run says June should
   * close at 680.00 while the books carry 780.00, dropping that row
   * makes the report agree with the ledger by concealing the very
   * disagreement the reader needs. A run row is the evidence the
   * portfolio was assessed, and the stage splits and EAD live only
   * there — the journal carries two lines and no IFRS 9 detail.
   *
   * So: every run is a row, and each row says plainly what its
   * computation implies, what was booked, and the difference.
   *
   *   computedDelta   this run's movement against the closing provision
   *                   of the previous PERIOD — the same baseline
   *                   `EclRepository.run` uses, looked up outside the
   *                   report window when it has to be, so it does not
   *                   depend on the range requested.
   *   bookedDelta     what the journal holds for this row's period. Net
   *                   movement on the allowance account across that
   *                   period's ECL entries. Zero for a period whose
   *                   entry has been reversed — a reversed entry booked
   *                   nothing, on net.
   *   unbookedDelta   computedDelta − bookedDelta. Zero on a clean
   *                   posting run. Non-zero exactly when a computation
   *                   and the books disagree, which is the number this
   *                   report exists to surface.
   *   postedByThisRun whether THIS run wrote the entry. Summing
   *                   `bookedDelta` over the rows where this is true
   *                   gives the net ECL movement in the general ledger
   *                   for the window, and cannot double-count a period
   *                   that was run twice.
   *   journalEntryId  the entry GOVERNING the period, from the journal —
   *                   not the run's own column, which is null on a
   *                   re-run. A reader asking "where is this in the GL?"
   *                   gets an answer on every row of a booked period.
   *
   * `delta` is gone rather than redefined. It was neither of the two
   * numbers above, and a reader with last quarter's spreadsheet should
   * be made to notice that rather than quietly get a different figure
   * under the same heading.
   *
   * §11: every peso here is summed as integer centavos.
   */
  private async eclMovement(from: Date, to: Date) {
    const runs = await this.prisma.eclRun.findMany({
      where: { asOf: { gte: from, lte: to } },
      orderBy: { asOf: "asc" },
    });
    if (runs.length === 0) return [];

    const closingByPeriod = await this.eclClosingProvisions(runs);
    const ledger = await this.eclLedgerMovements(runs);

    return runs.map((r) => {
      const ref = eclPeriodRef(r.periodStart, r.periodEnd);
      const totalEcl = toCentavos(String(r.totalEcl));
      const computed = totalEcl - baselineFor(closingByPeriod, r.periodEnd);
      const booked = ledger.get(ref);
      const bookedDelta = booked?.centavos ?? 0;
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
        totalEcl: pesos(totalEcl),
        computedDelta: pesos(computed),
        bookedDelta: pesos(bookedDelta),
        unbookedDelta: pesos(computed - bookedDelta),
        postedByThisRun: r.journalEntryId !== null,
        journalEntryId: booked?.entryId ?? null,
      };
    });
  }

  /**
   * Closing provision (in centavos) per period, keyed by `periodEnd`
   * time — the window's own runs plus enough earlier history to give the
   * first of them a baseline.
   *
   * A period that was run more than once closes at the figure its LATEST
   * run computed, which is why `asOf` breaks the tie. `EclRepository.run`
   * leaves that tie to `orderBy: { periodEnd: "desc" }` alone and so
   * picks arbitrarily among re-runs; the report cannot, because it has to
   * produce the same number twice.
   *
   * One extra query, bounded: ECL is cut monthly, so 400 rows is decades
   * of history including re-runs.
   */
  private async eclClosingProvisions(
    runs: Array<{ periodEnd: Date; asOf: Date; totalEcl: unknown }>,
  ): Promise<Map<number, number>> {
    const earliest = runs.reduce(
      (min, r) => Math.min(min, r.periodEnd.getTime()),
      Number.POSITIVE_INFINITY,
    );
    const history = await this.prisma.eclRun.findMany({
      where: { periodEnd: { lt: new Date(earliest) } },
      orderBy: [{ periodEnd: "desc" }, { asOf: "desc" }],
      select: { periodEnd: true, asOf: true, totalEcl: true },
      take: 400,
    });

    const latestAsOf = new Map<number, number>();
    const closing = new Map<number, number>();
    for (const r of [...history, ...runs]) {
      const key = r.periodEnd.getTime();
      const seen = latestAsOf.get(key);
      if (seen !== undefined && seen >= r.asOf.getTime()) continue;
      latestAsOf.set(key, r.asOf.getTime());
      closing.set(key, toCentavos(String(r.totalEcl)));
    }
    return closing;
  }

  /**
   * What the journal actually booked for each period in `runs`, in
   * centavos, signed the way the provision moved: positive is a build.
   *
   * Read off the ALLOWANCE account rather than the impairment expense
   * because the allowance is the stock account the provision lives in —
   * a build credits it, a release debits it. Entries that have been
   * reversed are skipped: on net they booked nothing, and a period
   * sitting reversed-and-not-yet-reposted is exactly a case where the
   * report must show the whole movement as unbooked.
   */
  private async eclLedgerMovements(
    runs: Array<{ periodStart: Date; periodEnd: Date }>,
  ): Promise<Map<string, { centavos: number; entryId: string }>> {
    const refs = [
      ...new Set(runs.map((r) => eclPeriodRef(r.periodStart, r.periodEnd))),
    ];
    const entries = await this.prisma.journalEntry.findMany({
      where: {
        source: "ECL_PROVISION",
        sourceRefType: "EclPeriod",
        sourceRefId: { in: refs },
      },
      select: {
        id: true,
        sourceRefId: true,
        reversedById: true,
        lines: {
          select: {
            debit: true,
            credit: true,
            account: { select: { code: true } },
          },
        },
      },
    });

    const out = new Map<string, { centavos: number; entryId: string }>();
    for (const e of entries) {
      const ref = e.sourceRefId;
      if (!ref) continue;
      const movement = e.reversedById
        ? 0
        : e.lines
            .filter(
              (l) => l.account.code === ACCOUNT_CODES.ALLOWANCE_FOR_DOUBTFUL,
            )
            .reduce(
              (sum, l) =>
                sum +
                toCentavos(String(l.credit)) -
                toCentavos(String(l.debit)),
              0,
            );
      const prior = out.get(ref);
      out.set(ref, {
        centavos: (prior?.centavos ?? 0) + movement,
        entryId: prior?.entryId ?? e.id,
      });
    }
    return out;
  }
}

/**
 * Closing provision of the period immediately before `periodEnd`, in
 * centavos. Zero when there is none — a first-ever run books its whole
 * provision, which is the movement from nothing.
 */
function baselineFor(closing: Map<number, number>, periodEnd: Date): number {
  let best: number | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const [at, centavos] of closing) {
    if (at < periodEnd.getTime() && at > bestAt) {
      bestAt = at;
      best = centavos;
    }
  }
  return best ?? 0;
}

/** Integer centavos → the 2-decimal number the report columns carry. */
function pesos(centavos: number): number {
  return centavos / 100;
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
