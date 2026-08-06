/**
 * Customer Ledger — a unified statement of account.
 *
 * Pulls together every financial event for a customer in one chronological
 * stream + a section-wise summary:
 *
 *   • LOAN_DISBURSEMENT     — coop released funds to the customer
 *   • LOAN_PAYMENT          — customer paid against a loan
 *   • PENALTY_WAIVER        — coop forgave a late-fee balance
 *   • CONTRIBUTION          — member contribution (CBU / mortuary / emergency)
 *   • SAVINGS_DEPOSIT       — voluntary savings deposit
 *   • SAVINGS_WITHDRAWAL    — savings withdrawal
 *
 * Each entry carries a `direction`:
 *   INFLOW  → value flowing TO the customer (got a loan, withdrew savings)
 *   OUTFLOW → value flowing FROM the customer (paid a loan, deposited savings,
 *             contributed to a fund). The customer's "net position with the
 *             coop" can be reasoned about from these.
 *
 * The repository does the joining + shaping work but **never crosses domain
 * boundaries** the way the GL does. This is not a journal — it's an
 * operator-facing statement built from the source data, so cancellations /
 * adjustments / reversals show up as discrete entries rather than as
 * crossed-out totals.
 */

import { ledgerPositions, type PositionResult } from "@loan/loans";
import type { Prisma, PrismaClient } from "@prisma/client";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type LedgerEntryKind =
  | "LOAN_DISBURSEMENT"
  | "LOAN_PAYMENT"
  | "PENALTY_WAIVER"
  | "CONTRIBUTION"
  | "SAVINGS_DEPOSIT"
  | "SAVINGS_WITHDRAWAL";

export type LedgerEntryDirection = "INFLOW" | "OUTFLOW";

export interface LedgerEntry {
  /** ISO date for sorting + display. */
  date: string;
  kind: LedgerEntryKind;
  description: string;
  /** Always positive — direction tells you which way it goes. */
  amount: number;
  direction: LedgerEntryDirection;
  /** Loan ref number when the entry is loan-related, null otherwise. */
  loanNumber: string | null;
  /** Optional external reference (e.g. payment provider id, payment ref). */
  ref?: string | null;
  /** Free-form notes captured at booking time, when any. */
  notes?: string | null;
  /**
   * What the member owed after this entry — principal plus scheduled
   * interest on every live loan, less everything repaid or waived.
   *
   * Both columns accumulate oldest → newest; `entries` is returned
   * newest-first, so the FIRST row carries the current position.
   */
  owedAfter: number;
  /**
   * What the coop held for the member after this entry — savings,
   * capital build-up, and any cash paid beyond what a loan could
   * absorb. Deliberately NOT netted against `owedAfter`: the two are
   * different claims, and adding them told a borrower his interest
   * payments were a deposit.
   */
  heldAfter: number;
  /**
   * The refundable slice of a CONTRIBUTION row — the capital build-up,
   * as against the pooled mortuary and emergency funds bundled in the
   * same entry. Only meaningful on CONTRIBUTION.
   */
  refundableAmount?: number;
}

export interface LedgerSummary {
  totalDisbursed: number;
  totalRepaid: number;
  totalPenaltyWaived: number;
  outstandingPrincipal: number;
  savingsBalance: number;
  savingsDeposits: number;
  savingsWithdrawals: number;
  contributionsTotal: number;
  capitalBuildUp: number;
  mortuaryFund: number;
  emergencyFund: number;
  /**
   * What the member owes the coop right now — principal plus scheduled
   * interest on live loans, less repayments and waivers.
   *
   * Summed across loans, each floored at zero. Overpaying one loan does
   * not settle another: a member with a defaulted loan and an overpaid
   * one still owes the default.
   */
  amountOwed: number;
  /**
   * What the coop holds for the member — savings, capital build-up, and
   * cash paid beyond what a loan could absorb (which the books carry in
   * 2100 Customer Advance Payments). Excludes the mortuary and emergency
   * funds, which are pooled and spent on claims rather than returned.
   *
   * NEVER add this to `amountOwed`. Their sum replaced a figure that
   * called a borrower's interest a deposit; a member with ₱10,000 saved
   * and ₱10,000 borrowed owes and is owed, and neither cancels.
   */
  amountHeld: number;
}

export interface CustomerLedger {
  customer: {
    id: string;
    number: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
    email: string | null;
    phone: string;
  };
  /** Time of generation. Helps when exporting + comparing. */
  asOf: string;
  /** Effective filter bounds — echoes back what the caller asked for. */
  range: {
    from: string | null;
    to: string | null;
  };
  /** Kind filter — 'ALL' | 'LOANS' | 'COOP'. */
  scope: LedgerScope;
  summary: LedgerSummary;
  entries: LedgerEntry[];
}

export type LedgerScope = "ALL" | "LOANS" | "COOP";

export interface LedgerOptions {
  /** Inclusive lower bound (ISO date). */
  from?: Date;
  /** Inclusive upper bound (ISO date). */
  to?: Date;
  scope?: LedgerScope;
}

/**
 * The two headline figures, taken off the final entry rather than
 * recomputed. Anything derived a second way drifts from the column it
 * is supposed to summarize.
 */
function positionTotals(positions: readonly PositionResult[]): {
  amountOwed: number;
  amountHeld: number;
} {
  const last = positions.length ? positions[positions.length - 1]! : null;
  return {
    amountOwed: round2(last?.owedAfter ?? 0),
    amountHeld: round2(last?.heldAfter ?? 0),
  };
}

export class CustomerLedgerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async build(
    customerId: string,
    opts: LedgerOptions = {},
  ): Promise<CustomerLedger> {
    const scope: LedgerScope = opts.scope ?? "ALL";
    const dateFilter = buildDateFilter(opts.from, opts.to);

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        id: true,
        number: true,
        firstName: true,
        middleName: true,
        lastName: true,
        email: true,
        phone: true,
      },
    });
    if (!customer) {
      throw new Error("Customer not found");
    }

    const wantLoans = scope === "ALL" || scope === "LOANS";
    const wantCoop = scope === "ALL" || scope === "COOP";

    // ─── Loan side ────────────────────────────────────────────────────
    //
    // Loans always need to be loaded (even for COOP-scoped ledgers) so we
    // can compute `outstandingPrincipal` — it's a snapshot you always want
    // visible on a statement. We just won't emit per-loan entries when
    // scope is COOP.
    const loans = await this.prisma.loanApplication.findMany({
      where: { customerId },
      select: {
        id: true,
        number: true,
        principal: true,
        status: true,
        disbursedAt: true,
        // Needed for what the member actually OWES. The disbursement's
        // cash is the principal; the debt is principal plus every
        // scheduled interest peso, and only the schedule knows that.
        schedule: { select: { totalDue: true } },
        payments: {
          select: {
            id: true,
            amount: true,
            paidOn: true,
            reference: true,
            notes: true,
          },
        },
        penaltyWaivers: {
          select: {
            id: true,
            waivedAmount: true,
            waivedAt: true,
            reason: true,
          },
        },
      },
    });

    const loanObligations: Record<string, number> = {};
    let totalDisbursed = 0;
    let totalRepaid = 0;
    let totalPenaltyWaived = 0;
    let outstandingPrincipal = 0;
    // Entries built without `runningBalance`; we attach it in a second
    // pass once the full combined timeline is sorted ascending. Casting
    // to LedgerEntry is then sound because the field is filled in.
    type Partial_ = Omit<LedgerEntry, "owedAfter" | "heldAfter">;
    const loanEntries: Partial_[] = [];

    for (const loan of loans) {
      const principalNum = Number(loan.principal);
      // Approximate outstanding = principal − sum(payments). This is good
      // enough for the statement; the loan detail page shows the precise
      // installment-allocated breakdown.
      const paidSum = loan.payments.reduce(
        (acc, p) => acc + Number(p.amount),
        0,
      );
      if (
        loan.status === "DISBURSED" ||
        loan.status === "ACTIVE" ||
        loan.status === "DEFAULTED"
      ) {
        outstandingPrincipal += Math.max(principalNum - paidSum, 0);
      }

      /*
       * What this loan obliges the member to repay, in total. Scheduled
       * amounts include interest; a loan with no schedule yet (never
       * disbursed) falls back to its principal so the map always has an
       * answer.
       */
      const obligation = loan.schedule.length
        ? loan.schedule.reduce((sum, r) => sum + Number(r.totalDue), 0)
        : principalNum;
      loanObligations[loan.number] = obligation;

      if (loan.disbursedAt) {
        totalDisbursed += principalNum;
        if (wantLoans && inRange(loan.disbursedAt, dateFilter)) {
          loanEntries.push({
            date: loan.disbursedAt.toISOString(),
            kind: "LOAN_DISBURSEMENT",
            description: `Loan ${loan.number} disbursed`,
            amount: principalNum,
            direction: "INFLOW",
            loanNumber: loan.number,
          });
        }
      }
      for (const p of loan.payments) {
        const amt = Number(p.amount);
        totalRepaid += amt;
        if (wantLoans && inRange(p.paidOn, dateFilter)) {
          loanEntries.push({
            date: p.paidOn.toISOString(),
            kind: "LOAN_PAYMENT",
            description: `Payment on ${loan.number}`,
            amount: amt,
            direction: "OUTFLOW",
            loanNumber: loan.number,
            ref: p.reference ?? null,
            notes: p.notes ?? null,
          });
        }
      }
      for (const w of loan.penaltyWaivers) {
        const amt = Number(w.waivedAmount);
        totalPenaltyWaived += amt;
        if (wantLoans && inRange(w.waivedAt, dateFilter)) {
          loanEntries.push({
            date: w.waivedAt.toISOString(),
            kind: "PENALTY_WAIVER",
            description: `Penalty waived on ${loan.number}`,
            amount: amt,
            direction: "INFLOW",
            loanNumber: loan.number,
            notes: w.reason,
          });
        }
      }
    }

    // ─── Cooperative side ─────────────────────────────────────────────
    const coopEntries: Partial_[] = [];
    let capitalBuildUp = 0;
    let mortuaryFund = 0;
    let emergencyFund = 0;
    let savingsDeposits = 0;
    let savingsWithdrawals = 0;

    // `wantCoop` already covers scope === "ALL" || scope === "COOP" (line 142),
    // so the previous belt-and-braces `|| scope === "ALL"` was dead code.
    if (wantCoop) {
      const contributions = await this.prisma.contribution.findMany({
        where: {
          customerId,
          ...(dateFilter ? { contributedAt: dateFilter } : {}),
        },
        select: {
          id: true,
          contributedAt: true,
          capitalBuildUp: true,
          mortuaryFund: true,
          emergencyFund: true,
          notes: true,
        },
        orderBy: { contributedAt: "asc" },
      });
      for (const c of contributions) {
        const cbu = Number(c.capitalBuildUp);
        const mort = Number(c.mortuaryFund);
        const emer = Number(c.emergencyFund);
        const total = cbu + mort + emer;
        capitalBuildUp += cbu;
        mortuaryFund += mort;
        emergencyFund += emer;
        if (wantCoop) {
          const parts: string[] = [];
          if (cbu > 0) parts.push(`CBU ₱${cbu.toLocaleString()}`);
          if (mort > 0) parts.push(`Mortuary ₱${mort.toLocaleString()}`);
          if (emer > 0) parts.push(`Emergency ₱${emer.toLocaleString()}`);
          coopEntries.push({
            // Only the CBU comes back to the member; mortuary and
            // emergency are pooled and spent on claims.
            refundableAmount: cbu,
            date: c.contributedAt.toISOString(),
            kind: "CONTRIBUTION",
            description: `Contribution — ${parts.join(" · ") || "no allocation"}`,
            amount: total,
            direction: "OUTFLOW",
            loanNumber: null,
            notes: c.notes ?? null,
          });
        }
      }

      const savings = await this.prisma.savingsTransaction.findMany({
        where: { customerId, ...(dateFilter ? { txnDate: dateFilter } : {}) },
        select: {
          id: true,
          kind: true,
          amount: true,
          txnDate: true,
          notes: true,
        },
        orderBy: { txnDate: "asc" },
      });
      for (const s of savings) {
        const amt = Number(s.amount);
        if (s.kind === "DEPOSIT") {
          savingsDeposits += amt;
        } else {
          savingsWithdrawals += amt;
        }
        if (wantCoop) {
          coopEntries.push({
            date: s.txnDate.toISOString(),
            kind:
              s.kind === "DEPOSIT" ? "SAVINGS_DEPOSIT" : "SAVINGS_WITHDRAWAL",
            description:
              s.kind === "DEPOSIT" ? "Savings deposit" : "Savings withdrawal",
            amount: amt,
            direction: s.kind === "DEPOSIT" ? "OUTFLOW" : "INFLOW",
            loanNumber: null,
            notes: s.notes ?? null,
          });
        }
      }
    }

    // ─── Interleave + compute running balance ─────────────────────────
    // We need the balance computed in chronological order (oldest →
    // newest) so each row reflects "after this event was applied", then
    // we flip back to newest-first for display.
    const combined = [...loanEntries, ...coopEntries].sort(
      (a, b) => +new Date(a.date) - +new Date(b.date),
    );
    /*
     * Two positions, never one. See @loan/loans/ledger-position for why
     * — briefly, a single "net position" made a borrower's interest
     * payments look like a deposit, because it added a debt he was
     * settling to savings he did not have.
     *
     * The obligation map is keyed by loan number and holds the FULL
     * scheduled amount, so a disbursed loan starts owing principal plus
     * interest rather than just the cash that changed hands.
     */
    const positions = ledgerPositions(
      combined.map((e) => ({
        kind: e.kind,
        amount: e.amount,
        loanNumber: e.loanNumber,
        refundableAmount: e.refundableAmount,
      })),
      loanObligations,
    );
    const withBalance: LedgerEntry[] = combined.map((e, i) => ({
      ...e,
      owedAfter: positions[i]!.owedAfter,
      heldAfter: positions[i]!.heldAfter,
    }));
    // Display order: newest first.
    const entries = withBalance.reverse();

    const summary: LedgerSummary = {
      totalDisbursed,
      totalRepaid,
      totalPenaltyWaived,
      outstandingPrincipal,
      savingsBalance: savingsDeposits - savingsWithdrawals,
      savingsDeposits,
      savingsWithdrawals,
      contributionsTotal: capitalBuildUp + mortuaryFund + emergencyFund,
      capitalBuildUp,
      mortuaryFund,
      emergencyFund,
      /*
       * `netCustomerPosition` used to live here: repayments plus
       * savings plus every contribution, minus disbursements. It made a
       * borrower who repaid ₱56,735.76 on a ₱50,000 loan look like a
       * ₱6,735.76 depositor, because the interest he was charged landed
       * on the same side of the sum as money the coop was holding.
       *
       * Replaced by two figures that answer two different questions and
       * must never be added together. A member who has saved ₱10,000
       * and borrowed ₱10,000 is not square with the coop: they owe and
       * are owed, and either can be called without the other.
       */
      /*
       * BOTH read off the last position, so the cards can never
       * disagree with the final row of the table beneath them.
       *
       * `amountHeld` was briefly recomputed here as savings + CBU. That
       * looked equivalent and wasn't: it missed cash paid beyond what a
       * loan could absorb, which the books carry in 2100 Customer
       * Advance Payments as a liability. One member sat on ₱279,360 of
       * advances while his statement said the coop held nothing.
       */
      ...positionTotals(positions),
    };

    return {
      customer,
      asOf: new Date().toISOString(),
      range: {
        from: opts.from ? opts.from.toISOString() : null,
        to: opts.to ? opts.to.toISOString() : null,
      },
      scope,
      summary,
      entries,
    };
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function buildDateFilter(
  from?: Date,
  to?: Date,
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  const f: Prisma.DateTimeFilter = {};
  if (from) f.gte = from;
  if (to) f.lte = to;
  return f;
}

function inRange(
  date: Date | null | undefined,
  filter: Prisma.DateTimeFilter | undefined,
): boolean {
  if (!date) return false;
  if (!filter) return true;
  if (filter.gte && date < (filter.gte as Date)) return false;
  if (filter.lte && date > (filter.lte as Date)) return false;
  return true;
}
