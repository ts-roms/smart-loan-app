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

import type { Prisma, PrismaClient } from "@prisma/client";

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
   * Net customer position AFTER this entry was applied. Same sign
   * convention as `LedgerSummary.netCustomerPosition`:
   *   • positive → customer is a net depositor (coop owes them, or holds
   *     their savings/contributions in excess of any borrowed)
   *   • negative → customer is a net borrower (they've received more
   *     than they've paid back)
   * Accumulates oldest → newest; the returned `entries` array is in
   * newest-first order so the latest row carries the current balance.
   */
  runningBalance: number;
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
  /** Net of customer-to-coop minus coop-to-customer for the period. */
  netCustomerPosition: number;
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

    let totalDisbursed = 0;
    let totalRepaid = 0;
    let totalPenaltyWaived = 0;
    let outstandingPrincipal = 0;
    // Entries built without `runningBalance`; we attach it in a second
    // pass once the full combined timeline is sorted ascending. Casting
    // to LedgerEntry is then sound because the field is filled in.
    type Partial_ = Omit<LedgerEntry, "runningBalance">;
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

    if (wantCoop || scope === "ALL") {
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
    let balance = 0;
    const withBalance: LedgerEntry[] = combined.map((e) => {
      // Same sign convention as the summary's netCustomerPosition:
      // OUTFLOW (customer paid in) increases the balance, INFLOW
      // (customer received money/value) decreases it.
      const delta = e.direction === "OUTFLOW" ? +e.amount : -e.amount;
      balance += delta;
      return { ...e, runningBalance: balance };
    });
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
      // Net "what the customer has given the coop, minus what the coop
      // has given them" — positive means the customer is a net depositor.
      netCustomerPosition:
        totalRepaid +
        (savingsDeposits - savingsWithdrawals) +
        capitalBuildUp +
        mortuaryFund +
        emergencyFund -
        totalDisbursed -
        totalPenaltyWaived,
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
