/**
 * Consolidated customer exposure — the read path.
 *
 * One borrower, every loan they hold, one obligation. The question the
 * lender is actually asking before it approves a fifth loan is "what am
 * I already into this person for", and until that had an endpoint the
 * only answers available were per-loan ones.
 *
 * This repository is assembly, not arithmetic. Every figure it returns
 * comes out of `consolidatedExposure` in `@loan/loans`, which in turn
 * folds the balances that `LoanRepository.balancesFor` already produces
 * for the loan list. Nothing here re-derives a balance: a second
 * calculation that drifted from the first would put a different
 * exposure on the customer profile than on the loans it is made of.
 *
 * Nothing is stored. Exposure is derivable from loans and their
 * schedules at every instant, so persisting it would only create a
 * second version of the truth to go stale — a cached exposure that
 * missed this morning's payment is worse than no exposure figure at
 * all, because it looks authoritative.
 */

import { consolidatedExposure, type ConsolidatedExposure } from "@loan/loans";
import type { PrismaClient } from "@prisma/client";

import { LoanRepository } from "./loan.repository";

export interface CustomerExposure extends ConsolidatedExposure {
  customerId: string;
  customerNumber: string;
  /**
   * The instant the arrears were measured against. Echoed back because
   * "past due" is only meaningful relative to a moment, and a report
   * screenshotted without one can't be reconciled later.
   */
  asOf: string;
}

/**
 * Exposure as an underwriting input rather than as a report.
 *
 * Same fold, same figures, one thing added: what the borrower's
 * existing loans cost them PER MONTH. The consolidated view answers
 * "how much do they owe"; §16's disposable income needs "how much do
 * they pay", and no stored column holds it.
 */
export interface ExposureForDecision {
  exposure: ConsolidatedExposure;
  /**
   * Monthly cost of the borrower's existing obligations — see
   * {@link CustomerExposureRepository.forDecision} for how the window
   * is drawn and what it does and does not capture.
   */
  monthlyObligations: number;
  /** The instant every figure above was measured at. */
  asOf: Date;
}

export class CustomerExposureRepository {
  private readonly loans: LoanRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.loans = new LoanRepository(prisma);
  }

  /**
   * Build the exposure snapshot for one customer.
   *
   * Every loan is fetched, not just the live ones. The pure fold decides
   * what counts, and it needs the terminal rows to report them — a
   * written-off loan missing from the input can't be reported as
   * excluded, it just silently isn't there, which is the failure mode
   * this whole feature exists to close.
   *
   * Three queries regardless of how many loans the borrower has: the
   * loans themselves, then one `groupBy` each for balances and arrears.
   * Pulling schedules inline instead would ship every instalment of a
   * 360-month housing loan to compute two numbers from them.
   */
  async build(
    customerId: string,
    customerNumber: string,
    asOf: Date = new Date(),
  ): Promise<CustomerExposure> {
    const exposure = await this.fold(customerId, asOf);
    return {
      customerId,
      customerNumber,
      asOf: asOf.toISOString(),
      ...exposure,
    };
  }

  /**
   * The same snapshot, plus the monthly cost of it — what decisioning
   * needs and a profile page does not.
   *
   * ─── Why a second figure at all ─────────────────────────────────
   *
   * §16's disposable income subtracts "Existing Obligations", which is
   * a MONTHLY amount. Consolidated exposure is a stock — pesos owed —
   * and no arithmetic turns one into the other without knowing the
   * remaining term of each loan. The schedules know, so they are asked.
   *
   * ─── How the window is drawn ────────────────────────────────────
   *
   * Unpaid instalments falling due in the month AHEAD of `asOf`. Not a
   * contractual amortization recomputed from principal and rate — that
   * would be a second calculation, drifting from the schedule the
   * borrower actually pays, which is the mistake `consolidatedExposure`
   * was written to avoid. It is `balancesFor` again, with the schedule
   * narrowed, exactly as `pastDueFor` is.
   *
   * Forward-looking on purpose, and this is the part that matters for
   * double-counting: the window starts at `asOf`, so arrears are NOT in
   * it. Money already overdue reaches the engine as `existingPastDue`,
   * a separate field. An instalment cannot be counted in both.
   *
   * Frequency comes out right without special-casing: a monthly loan
   * contributes one instalment to the window, a bi-weekly one roughly
   * two, a weekly one roughly four — which is what those loans cost per
   * month.
   *
   * ─── What it understates, and why that is accepted ──────────────
   *
   * A loan with no schedule contributes ₱0. That is an APPROVED loan
   * awaiting disbursement: it is inside `exposure.total` (the lender
   * has committed the money) but nothing is due on it yet, because no
   * instalment exists to be due. The obligation appears the moment the
   * schedule is written. Reporting a guessed instalment instead would
   * put a number on the decision record that no schedule backs.
   */
  async forDecision(
    customerId: string,
    asOf: Date = new Date(),
  ): Promise<ExposureForDecision> {
    const exposure = await this.fold(customerId, asOf);

    /*
     * Only the loans the fold says are live. Running the window over
     * every row would pull instalments off a RESTRUCTURED predecessor
     * whose successor is also in the list — the same double-count
     * `consolidatedExposure` excludes it to prevent, reintroduced one
     * layer down.
     */
    const countedIds = exposure.loans
      .filter((l) => l.counted)
      .map((l) => l.loanId);

    const due = await this.loans.balancesFor(countedIds, {
      paidInFullAt: null,
      dueDate: { gte: asOf, lt: addOneMonth(asOf) },
    });

    let monthlyObligations = 0;
    for (const balance of due.values())
      monthlyObligations += balance.outstanding;

    return {
      exposure,
      // Re-rounded after summing, for the reason `consolidatedExposure`
      // gives: a dozen two-decimal values added in binary floating point
      // land a few millionths off, and this figure is subtracted from a
      // borrower's income on a record someone may have to defend.
      monthlyObligations: Math.round(monthlyObligations * 100) / 100,
      asOf,
    };
  }

  /** The shared read — every figure both entry points are built from. */
  private async fold(
    customerId: string,
    asOf: Date,
  ): Promise<ConsolidatedExposure> {
    const rows = await this.prisma.loanApplication.findMany({
      where: { customerId },
      orderBy: { submittedAt: "desc" },
      select: {
        id: true,
        number: true,
        productCode: true,
        principal: true,
        status: true,
        // The balance at write-off, which is what actually went to Bad
        // Debt. Not interchangeable with `principal`: a borrower who
        // repaid half before defaulting had half the contracted amount
        // written off.
        writeOffAmount: true,
        disbursedAt: true,
        product: { select: { name: true } },
      },
    });

    const loanIds = rows.map((r) => r.id);
    const [balances, pastDue] = await Promise.all([
      this.loans.balancesFor(loanIds),
      this.loans.pastDueFor(loanIds, asOf),
    ]);

    const exposure = consolidatedExposure(
      rows.map((row) => ({
        loanId: row.id,
        loanNumber: row.number,
        productCode: row.productCode,
        productName: row.product?.name ?? null,
        status: row.status,
        // Decimal over the wire. `consolidatedExposure` coerces, but
        // Number here keeps the boundary in one place.
        principal: Number(row.principal),
        writeOffAmount:
          row.writeOffAmount != null ? Number(row.writeOffAmount) : null,
        // Absent from the map means "no schedule", which the fold
        // treats differently from a zero balance — see loanExposure.
        balance: balances.get(row.id) ?? null,
        overdue: pastDue.get(row.id) ?? null,
      })),
    );

    return exposure;
  }
}

/**
 * One calendar month on, clamped to the end of the target month.
 *
 * Naive `setMonth(+1)` turns 31 January into 3 March, and a window that
 * wide sweeps up both February's and March's instalments — reporting a
 * borrower's monthly obligation as double its real size, for no reason
 * other than which day of the month the officer happened to run the
 * application on. Clamping to 28 February keeps exactly one monthly
 * instalment in the window whatever the start date.
 */
function addOneMonth(from: Date): Date {
  const out = new Date(from.getTime());
  const day = out.getDate();
  out.setDate(1);
  out.setMonth(out.getMonth() + 1);
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(day, lastDay));
  return out;
}
