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
    const rows = await this.prisma.loanApplication.findMany({
      where: { customerId },
      orderBy: { submittedAt: "desc" },
      select: {
        id: true,
        number: true,
        productCode: true,
        principal: true,
        status: true,
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
        // Absent from the map means "no schedule", which the fold
        // treats differently from a zero balance — see loanExposure.
        balance: balances.get(row.id) ?? null,
        overdue: pastDue.get(row.id) ?? null,
      })),
    );

    return {
      customerId,
      customerNumber,
      asOf: asOf.toISOString(),
      ...exposure,
    };
  }
}
