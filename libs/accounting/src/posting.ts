/**
 * Posting helpers. Pure shape — these functions describe the journal lines
 * a given business event should produce. Persistence is the caller's job
 * (AccountingRepository.post inside a Prisma transaction).
 *
 * Rule of the system: every entry must balance (sum debits == sum credits).
 * `buildEntry` enforces it.
 */

import { ACCOUNT_CODES, bucketToAccount } from "./chart";
import { type MoneyInput, fromCentavos, toCentavos } from "./money";

export interface JournalLineInput {
  /** Account code from the chart (resolved to id by the repository). */
  accountCode: string;
  debit: number;
  credit: number;
  memo?: string;
}

export type JournalSourceKind =
  | "MANUAL"
  | "LOAN_DISBURSEMENT"
  | "LOAN_PAYMENT"
  | "REVERSAL"
  | "ADJUSTMENT"
  | "INTEREST_ACCRUAL"
  | "LATE_FEE_ACCRUAL"
  | "ECL_PROVISION"
  | "COOP_CONTRIBUTION"
  | "COOP_SAVINGS"
  | "COOP_FUND_IN"
  | "COOP_FUND_OUT"
  | "COOP_EXPENSE"
  | "COOP_OTHER_INCOME"
  | "COOP_BIG_BROTHER"
  // The three below mirror the Prisma JournalSource enum (schema.prisma
  // lines 932–940) — added so penaltyWaiveEntry / repossessionAuctionEntry /
  // leaseBuyoutEntry can declare the right `source` literal without tsc
  // narrowing it back to a generic string.
  | "PENALTY_WAIVE"
  | "REPOSSESSION_AUCTION"
  | "LEASE_BUYOUT";

export interface JournalEntryInput {
  entryDate: Date;
  memo?: string;
  source: JournalSourceKind;
  sourceRefType?: string;
  sourceRefId?: string;
  lines: JournalLineInput[];
}

const PENNY = 0.005;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Build + validate an entry. Throws if it doesn't balance. */
export function buildEntry(input: JournalEntryInput): JournalEntryInput {
  const rounded = input.lines.map((l) => ({
    ...l,
    debit: round2(l.debit),
    credit: round2(l.credit),
  }));
  // Validate BEFORE the zero-filter so negative amounts don't get
  // silently swept under the rug: a line with `debit: -5, credit: 0`
  // would otherwise be filtered out (both columns ≤ 0) and never
  // surface as an error.
  for (const line of rounded) {
    if (line.debit < 0 || line.credit < 0) {
      throw new Error(`Line for ${line.accountCode} has a negative amount.`);
    }
    if (line.debit > 0 && line.credit > 0) {
      throw new Error(
        `Line for ${line.accountCode} has both debit and credit.`,
      );
    }
  }
  const lines = rounded.filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.length < 2) {
    throw new Error("A journal entry needs at least two lines.");
  }
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(debits - credits) > PENNY) {
    throw new Error(
      `Journal entry does not balance: debits=${debits.toFixed(2)} credits=${credits.toFixed(2)}`,
    );
  }
  return { ...input, lines };
}

/**
 * Loan disbursement with fees withheld from cash out.
 *
 *   Dr Loans Receivable    principal           (full principal owed by customer)
 *     Cr Cash              netDisbursement     (cash that actually leaves)
 *     Cr Fee Income        feeTotal            (processing + documentary stamp)
 *
 * When `feeTotal` is 0, this collapses to the classic 2-line disbursement.
 */
export function loanDisbursementEntry(args: {
  loanId: string;
  loanNumber: string;
  principal: number;
  feeTotal?: number;
  disbursedAt: Date;
}): JournalEntryInput {
  const feeTotal = args.feeTotal ?? 0;
  const cashOut = args.principal - feeTotal;
  const lines: JournalLineInput[] = [
    {
      accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
      debit: args.principal,
      credit: 0,
      memo: `Loan ${args.loanNumber}`,
    },
    {
      accountCode: ACCOUNT_CODES.CASH,
      debit: 0,
      credit: cashOut,
      memo: `Loan ${args.loanNumber} (net of fees)`,
    },
  ];
  if (feeTotal > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.FEE_INCOME,
      debit: 0,
      credit: feeTotal,
      memo: `Origination fees ${args.loanNumber}`,
    });
  }
  return buildEntry({
    entryDate: args.disbursedAt,
    source: "LOAN_DISBURSEMENT",
    sourceRefType: "LoanApplication",
    sourceRefId: args.loanId,
    memo: `Disbursement of ${args.loanNumber}`,
    lines,
  });
}

/**
 * Pre-termination fee on early close.
 *   Dr Cash             fee
 *     Cr Fee Income     fee
 *
 * Tagged by loanId so multiple closures (shouldn't happen) don't double-book.
 */
export function preTerminationFeeEntry(args: {
  loanId: string;
  loanNumber: string;
  fee: number;
  closedAt: Date;
}): JournalEntryInput {
  return buildEntry({
    entryDate: args.closedAt,
    source: "MANUAL",
    sourceRefType: "LoanPreTermination",
    sourceRefId: args.loanId,
    memo: `Pre-termination fee ${args.loanNumber}`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.CASH,
        debit: args.fee,
        credit: 0,
      },
      {
        accountCode: ACCOUNT_CODES.FEE_INCOME,
        debit: 0,
        credit: args.fee,
      },
    ],
  });
}

/**
 * Agent commission, recognized at disbursement.
 *
 *   Dr Agent Commission Expense    amount
 *     Cr Agent Commission Payable  amount
 *
 * Expense and PAYABLE, not expense and cash. The agent has earned the
 * money the moment the loan is funded, but paying them is a separate
 * event on a separate day — usually a batch at month end. Crediting cash
 * here would report money as having left the building when it hasn't,
 * and leave nothing on the books saying who is owed what.
 *
 * `sourceRefId` is the loan, so `postIfAbsent` makes a re-run of a
 * disbursement idempotent rather than paying the agent twice.
 */
export function agentCommissionEntry(args: {
  loanId: string;
  loanNumber: string;
  agentNumber: string;
  amount: number;
  disbursedAt: Date;
}): JournalEntryInput | null {
  // Nothing to post at a zero rate — and buildEntry would reject the
  // entry anyway, since it filters zero lines and then demands two.
  if (round2(args.amount) <= 0) return null;
  return buildEntry({
    entryDate: args.disbursedAt,
    source: "MANUAL",
    sourceRefType: "AgentCommission",
    sourceRefId: args.loanId,
    memo: `Agent commission ${args.agentNumber} — loan ${args.loanNumber}`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.AGENT_COMMISSION_EXPENSE,
        debit: args.amount,
        credit: 0,
      },
      {
        accountCode: ACCOUNT_CODES.AGENT_COMMISSION_PAYABLE,
        debit: 0,
        credit: args.amount,
      },
    ],
  });
}

/**
 * Paying an agent what they are owed.
 *
 *   Dr Agent Commission Payable    amount
 *     Cr Cash                      amount
 *
 * The exact mirror of `agentCommissionEntry`, and the reason that one
 * credits a payable rather than cash: booking the expense and paying it
 * are two events on two days, and only this one moves money.
 *
 * No expense line here. The cost was recognized at disbursement; debiting
 * it again would double the commission on the income statement while the
 * cash only left once.
 *
 * `sourceRefId` is the payout, so a re-submitted run settles once.
 */
export function agentPayoutEntry(args: {
  payoutId: string;
  payoutNumber: string;
  agentNumber: string;
  amount: number;
  paidOn: Date;
}): JournalEntryInput {
  return buildEntry({
    entryDate: args.paidOn,
    source: "MANUAL",
    sourceRefType: "AgentPayout",
    sourceRefId: args.payoutId,
    memo: `Agent payout ${args.payoutNumber} — ${args.agentNumber}`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.AGENT_COMMISSION_PAYABLE,
        debit: args.amount,
        credit: 0,
      },
      { accountCode: ACCOUNT_CODES.CASH, debit: 0, credit: args.amount },
    ],
  });
}

/**
 * Loan payment. Allocation arrives split into interest + principal portions
 * (the loan repository computes this from the schedule).
 *   Dr Cash                    total
 *     Cr Interest Income       interestPortion
 *     Cr Loans Receivable      principalPortion
 *     Cr Customer Advances     advancePortion
 *
 * `advancePortion` is the slice of the payment that exceeded everything the
 * loan still owed. It must NOT be folded into `principalPortion` — doing so
 * drives Loans Receivable below zero for that loan. It's money we hold on
 * the borrower's behalf, so it belongs on the liability side.
 */
export function loanPaymentEntry(args: {
  loanId: string;
  loanNumber: string;
  paymentId: string;
  amount: number;
  interestPortion: number;
  principalPortion: number;
  /**
   * Fee and penalty portions (§26). Both credit Loans Receivable, NOT Fee
   * Income — and that is the whole point of them being separate arguments.
   *
   * A late fee is recognized as income the moment it accrues:
   * `lateFeeAccrualEntry` posts Dr Loans Receivable / Cr Fee Income, so by
   * the time the borrower pays it the income is already on the books and
   * the charge is sitting in the receivable. Collecting it is Dr Cash / Cr
   * Loans Receivable — the asset converting to cash. Crediting Fee Income
   * again here would recognize the same peso of income twice.
   *
   * They are separate from `principalPortion` even though they hit the same
   * account because the memo has to say which is which — a receivable
   * credit that reads "Principal" when it settled a penalty makes the
   * subledger impossible to tie out against the schedule.
   *
   * This assumes the accrue-then-collect convention that every charge in
   * this system currently follows. A fee that is charged and collected in
   * the same breath, never having been accrued, would need to credit Fee
   * Income instead; no such fee is modelled today.
   */
  feePortion?: number;
  penaltyPortion?: number;
  /** Excess over the full remaining balance. Booked as a liability. */
  advancePortion?: number;
  paidOn: Date;
}): JournalEntryInput {
  const lines: JournalLineInput[] = [
    {
      accountCode: ACCOUNT_CODES.CASH,
      debit: args.amount,
      credit: 0,
      memo: `Payment on ${args.loanNumber}`,
    },
  ];
  if ((args.feePortion ?? 0) > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
      debit: 0,
      credit: args.feePortion!,
      memo: `Fees on ${args.loanNumber}`,
    });
  }
  if ((args.penaltyPortion ?? 0) > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
      debit: 0,
      credit: args.penaltyPortion!,
      memo: `Penalties on ${args.loanNumber}`,
    });
  }
  if (args.interestPortion > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.INTEREST_INCOME,
      debit: 0,
      credit: args.interestPortion,
      memo: `Interest on ${args.loanNumber}`,
    });
  }
  if (args.principalPortion > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
      debit: 0,
      credit: args.principalPortion,
      memo: `Principal on ${args.loanNumber}`,
    });
  }
  if ((args.advancePortion ?? 0) > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.CUSTOMER_ADVANCES,
      debit: 0,
      credit: args.advancePortion!,
      memo: `Advance / overpayment on ${args.loanNumber}`,
    });
  }
  return buildEntry({
    entryDate: args.paidOn,
    source: "LOAN_PAYMENT",
    sourceRefType: "LoanPayment",
    sourceRefId: args.paymentId,
    memo: `Payment on ${args.loanNumber}`,
    lines,
  });
}

/**
 * Cash recovered on a loan that was previously written off.
 *
 *   Dr Cash                   amount
 *     Cr Bad Debt Recovery    amount
 *
 * Why this is not `loanPaymentEntry`. A write-off marks every
 * instalment paid in full and credits Loans Receivable down to nothing,
 * so a later payment finds no open instalment to allocate against. It
 * therefore fell through to the overpayment branch and was booked as
 * Cr Customer Advances — recording the borrower who defaulted as a
 * CREDITOR of the lender, for the money the lender just clawed back.
 *
 * The write-off itself is not reversed. The expense belonged to the
 * period the loan was given up on; the recovery belongs to the period
 * the cash arrived. Reversing would restate a closed period and imply
 * the original judgement was wrong, which it was not — it was correct
 * on the information available then.
 */
export function badDebtRecoveryEntry(args: {
  loanId: string;
  loanNumber: string;
  paymentId: string;
  amount: number;
  paidOn: Date;
}): JournalEntryInput | null {
  const amount = round2(args.amount);
  if (amount <= 0) return null;
  return buildEntry({
    entryDate: args.paidOn,
    source: "LOAN_PAYMENT",
    sourceRefType: "LoanPayment",
    sourceRefId: args.paymentId,
    memo: `Recovery on written-off ${args.loanNumber}`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.CASH,
        debit: amount,
        credit: 0,
        memo: `Recovery on ${args.loanNumber}`,
      },
      {
        accountCode: ACCOUNT_CODES.BAD_DEBT_RECOVERY,
        debit: 0,
        credit: amount,
        memo: `Recovery of written-off ${args.loanNumber}`,
      },
    ],
  });
}

/**
 * Monthly interest accrual for one scheduled installment.
 *   Dr Interest Receivable   interest
 *     Cr Interest Income     interest
 *
 * Tagged by scheduleId so the cron is idempotent (postIfAbsent).
 */
export function interestAccrualEntry(args: {
  scheduleId: string;
  loanNumber: string;
  installmentNo: number;
  interest: number;
  accruedOn: Date;
}): JournalEntryInput {
  return buildEntry({
    entryDate: args.accruedOn,
    source: "INTEREST_ACCRUAL",
    sourceRefType: "LoanScheduleAccrual",
    sourceRefId: args.scheduleId,
    memo: `Interest accrual ${args.loanNumber} #${args.installmentNo}`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.INTEREST_RECEIVABLE,
        debit: args.interest,
        credit: 0,
      },
      {
        accountCode: ACCOUNT_CODES.INTEREST_INCOME,
        debit: 0,
        credit: args.interest,
      },
    ],
  });
}

/**
 * Late fee accrual on an overdue installment.
 *   Dr Loans Receivable    feeAmount
 *     Cr Fee Income        feeAmount
 *
 * Tagged by (scheduleId, period) so daily runs don't double-book.
 */
export function lateFeeAccrualEntry(args: {
  scheduleId: string;
  loanNumber: string;
  installmentNo: number;
  feeAmount: number;
  accruedOn: Date;
  /** Used in sourceRefId together with scheduleId to keep daily idempotency. */
  periodKey: string;
}): JournalEntryInput {
  return buildEntry({
    entryDate: args.accruedOn,
    source: "LATE_FEE_ACCRUAL",
    sourceRefType: "LoanScheduleLateFee",
    sourceRefId: `${args.scheduleId}:${args.periodKey}`,
    memo: `Late fee ${args.loanNumber} #${args.installmentNo} (${args.periodKey})`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
        debit: args.feeAmount,
        credit: 0,
      },
      {
        accountCode: ACCOUNT_CODES.FEE_INCOME,
        debit: 0,
        credit: args.feeAmount,
      },
    ],
  });
}

/**
 * Reversing entry for a penalty waive. Backs out the late-fee accrual
 * that was previously booked as Dr Loans Receivable / Cr Fee Income —
 * we now Dr Fee Income (reducing previously-recognized income) and
 * Cr Loans Receivable (reducing the customer's outstanding penalty
 * balance) for the amount being waived.
 *
 *   Dr Fee Income            waivedAmount
 *     Cr Loans Receivable    waivedAmount
 */
export function penaltyWaiveEntry(args: {
  waiverId: string;
  loanId: string;
  loanNumber: string;
  waivedAmount: number;
  waivedOn: Date;
  reason: string;
}): JournalEntryInput {
  return buildEntry({
    entryDate: args.waivedOn,
    source: "PENALTY_WAIVE",
    sourceRefType: "PenaltyWaiver",
    sourceRefId: args.waiverId,
    memo: `Waive penalty ${args.loanNumber} — ${args.reason.slice(0, 200)}`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.FEE_INCOME,
        debit: args.waivedAmount,
        credit: 0,
      },
      {
        accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
        debit: 0,
        credit: args.waivedAmount,
      },
    ],
  });
}

/**
 * Auction settlement for a repossessed vehicle.
 *
 * Splits the proceeds against outstanding principal:
 *
 *   Dr Cash                       proceeds
 *     Cr Loans Receivable         min(proceeds, outstanding)
 *     Cr Refund Payable (other)   max(0, proceeds - outstanding)   // surplus
 *
 * If there's a shortfall (deficiency > 0) we additionally write off the
 * unrecoverable portion:
 *
 *   Dr Bad Debt Expense           deficiency
 *     Cr Loans Receivable         deficiency
 *
 * We emit both in one balanced entry so the auction settlement appears
 * as a single line on the GL.
 */
export function repossessionAuctionEntry(args: {
  caseId: string;
  loanId: string;
  loanNumber: string;
  outstandingAtRecovery: number;
  auctionProceeds: number;
  auctionedOn: Date;
}): JournalEntryInput {
  const proceeds = round2(args.auctionProceeds);
  const outstanding = round2(args.outstandingAtRecovery);
  const appliedToLoan = round2(Math.min(proceeds, outstanding));
  const deficiency = round2(Math.max(0, outstanding - proceeds));
  const surplus = round2(Math.max(0, proceeds - outstanding));

  const lines: Array<{
    accountCode: string;
    debit: number;
    credit: number;
    memo?: string;
  }> = [
    {
      accountCode: ACCOUNT_CODES.CASH,
      debit: proceeds,
      credit: 0,
      memo: `Auction proceeds ${args.loanNumber}`,
    },
    {
      accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
      debit: 0,
      credit: appliedToLoan,
      memo: `Settle ${args.loanNumber} via auction`,
    },
  ];

  if (deficiency > 0) {
    lines.push(
      {
        accountCode: ACCOUNT_CODES.BAD_DEBT_EXPENSE,
        debit: deficiency,
        credit: 0,
        memo: `Auction shortfall on ${args.loanNumber}`,
      },
      {
        accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
        debit: 0,
        credit: deficiency,
        memo: `Write-off shortfall on ${args.loanNumber}`,
      },
    );
  }

  if (surplus > 0) {
    /*
     * The surplus is the BORROWER'S money, held as a liability — not
     * income. Auction proceeds beyond the debt belong to the mortgagor;
     * 2100 Customer Advance Payments is this chart's account for
     * exactly that ("payments received in excess of everything a loan
     * still owes — refundable to the borrower").
     *
     * An earlier version credited Other Income on the grounds that no
     * refundable-liability account existed in the chart. It did; the
     * comment was stale. The cost was double-sided: income overstated
     * by money that was never the coop's, and the amount owed back to
     * the borrower recorded nowhere at all — a refund nobody would be
     * reminded to pay.
     */
    lines.push({
      accountCode: ACCOUNT_CODES.CUSTOMER_ADVANCES,
      debit: 0,
      credit: surplus,
      memo: `Auction surplus on ${args.loanNumber} — refundable to borrower`,
    });
  }

  return buildEntry({
    entryDate: args.auctionedOn,
    source: "REPOSSESSION_AUCTION",
    sourceRefType: "RepossessionCase",
    sourceRefId: args.caseId,
    memo: `Auction settlement ${args.loanNumber} — proceeds ${proceeds.toFixed(2)}, outstanding ${outstanding.toFixed(2)}, deficiency ${deficiency.toFixed(2)}`,
    lines,
  });
}

/**
 * Lease-to-Own residual buyout. Borrower pays the residual fee at the
 * end of the lease term to take title. The standard payment flow has
 * already covered the principal + interest; this entry books just the
 * residual amount.
 *
 *   Dr Cash               residualPaid
 *     Cr Lease Income     residualPaid
 *
 * (We use OTHER_INCOME for the credit because the lease economics
 * differ from amortizing loan interest; a fuller chart of accounts
 * would split this into a dedicated Lease Income account.)
 */
export function leaseBuyoutEntry(args: {
  agreementId: string;
  loanId: string;
  loanNumber: string;
  residualAmount: number;
  buyoutOn: Date;
}): JournalEntryInput {
  return buildEntry({
    entryDate: args.buyoutOn,
    source: "LEASE_BUYOUT",
    sourceRefType: "LeaseAgreement",
    sourceRefId: args.agreementId,
    memo: `Lease buyout ${args.loanNumber} — residual ${args.residualAmount.toFixed(2)}`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.CASH,
        debit: args.residualAmount,
        credit: 0,
      },
      {
        accountCode: ACCOUNT_CODES.OTHER_INCOME,
        debit: 0,
        credit: args.residualAmount,
      },
    ],
  });
}

/**
 * ECL provision movement for the period.
 *
 * We post the *delta* from the previous run, not the absolute level —
 * provisioning is a stock account, and the income statement only sees
 * period-on-period change.
 *
 *   delta > 0 (provision increased):
 *     Dr Impairment Loss               delta
 *       Cr Allowance for Doubtful      delta
 *
 *   delta < 0 (provision decreased — write-back):
 *     Dr Allowance for Doubtful        |delta|
 *       Cr Impairment Loss             |delta|
 *
 *   delta == 0: no entry; caller skips the post.
 *
 * Tagged by EclRun id so re-running for the same period (if the caller
 * deletes the prior run first) doesn't double-book; `postIfAbsent` in
 * the repository covers that.
 */
export function eclProvisionEntry(args: {
  eclRunId: string;
  delta: number;
  postedAt: Date;
  memo?: string;
}): JournalEntryInput | null {
  const delta = round2(args.delta);
  if (Math.abs(delta) < 0.01) return null;
  const isIncrease = delta > 0;
  const amount = Math.abs(delta);
  const memo =
    args.memo ??
    `ECL provision movement (${isIncrease ? "increase" : "release"})`;
  return buildEntry({
    entryDate: args.postedAt,
    source: "ECL_PROVISION",
    sourceRefType: "EclRun",
    sourceRefId: args.eclRunId,
    memo,
    lines: isIncrease
      ? [
          {
            accountCode: ACCOUNT_CODES.IMPAIRMENT_LOSS,
            debit: amount,
            credit: 0,
            memo: "ECL increase",
          },
          {
            accountCode: ACCOUNT_CODES.ALLOWANCE_FOR_DOUBTFUL,
            debit: 0,
            credit: amount,
            memo: "ECL allowance build",
          },
        ]
      : [
          {
            accountCode: ACCOUNT_CODES.ALLOWANCE_FOR_DOUBTFUL,
            debit: amount,
            credit: 0,
            memo: "ECL allowance release",
          },
          {
            accountCode: ACCOUNT_CODES.IMPAIRMENT_LOSS,
            debit: 0,
            credit: amount,
            memo: "ECL write-back",
          },
        ],
  });
}

// ─── Payment allocation (§26) ────────────────────────────────────────────

/**
 * The four buckets a payment can be applied to, in the vocabulary §26 uses.
 *
 * FEES and PENALTIES are distinct on purpose even though both credit the
 * same account today: a penalty is a late-payment charge that accrued
 * against a specific overdue installment, a fee is a service charge. A
 * cooperative that wants to collect one before the other must be able to
 * say so, and a report that lumps them together cannot be unlumped later.
 */
export type AllocationTier = "FEES" | "PENALTIES" | "INTEREST" | "PRINCIPAL";

/**
 * The allocation orders a loan may be written under.
 *
 * Named whole orders rather than a free-form array of tiers. Twenty-four
 * permutations of four tiers exist and most of them are not policies anyone
 * would sanction — "principal before interest, fees last" is not a
 * configuration, it is a mistake someone is about to make with a borrower's
 * money. A closed set makes the illegal states unrepresentable and lets the
 * database enforce it as an enum rather than leaving it to validation.
 *
 * Adding a genuinely-wanted order is a new entry here, a new enum value in
 * the schema, and a migration — deliberately more friction than editing a
 * JSON column, because each one is a promise to a borrower about how their
 * money will be applied.
 */
export type PaymentAllocationOrder = keyof typeof ALLOCATION_ORDERS;

export const ALLOCATION_ORDERS = {
  /**
   * Interest, then principal, within each installment. What every loan on
   * the books before §26 was written under, and the default for anything
   * that does not say otherwise.
   */
  INTEREST_PRINCIPAL: ["INTEREST", "PRINCIPAL"],

  /**
   * §26's stated default: fees, then penalties, then interest, then
   * principal. Collects what the borrower owes for falling behind before
   * anything reduces the debt itself.
   */
  FEES_PENALTIES_INTEREST_PRINCIPAL: [
    "FEES",
    "PENALTIES",
    "INTEREST",
    "PRINCIPAL",
  ],

  /**
   * The borrower-friendly inverse: the payment kills the loan first and
   * charges are settled only once the installment is otherwise current.
   * Slower to recover fee income, faster to get a borrower out of arrears.
   */
  INTEREST_PRINCIPAL_FEES_PENALTIES: [
    "INTEREST",
    "PRINCIPAL",
    "FEES",
    "PENALTIES",
  ],
} as const satisfies Record<string, readonly AllocationTier[]>;

/** The order every loan written before §26 pays under. */
export const DEFAULT_ALLOCATION_ORDER: PaymentAllocationOrder =
  "INTEREST_PRINCIPAL";

export interface InstallmentDue {
  interestDue: MoneyInput;
  principalDue: MoneyInput;
  /**
   * Interest already collected on this installment by earlier payments.
   * Defaults to 0. Callers holding persisted payment progress MUST pass
   * this — otherwise a second partial payment re-allocates against interest
   * that has already been recognized as income.
   */
  interestPaid?: MoneyInput;
  /** Principal already collected on this installment. Defaults to 0. */
  principalPaid?: MoneyInput;
  /**
   * Service fees payable on this installment, and how much of them has
   * already been collected. Both default to 0.
   *
   * NOTHING IN THIS SYSTEM POPULATES THESE YET. No per-installment fee
   * balance is modelled — processing fees, documentary stamp tax and
   * origination fees are all netted out of the disbursement proceeds, so a
   * borrower never owes them as a separate balance, and the pre-termination
   * fee is taken in cash at closure. The tier is here so the order is
   * expressible and the arithmetic is tested; see the note on
   * `allocatePayment` for what closing the gap would take.
   */
  feeDue?: MoneyInput;
  feePaid?: MoneyInput;
  /**
   * Late-payment penalties accrued against this installment, and how much
   * has been collected. Both default to 0.
   *
   * ALSO NOT POPULATED YET, but for a different reason than fees: the
   * accrued side is real and derivable (`LATE_FEE_ACCRUAL` journal entries
   * are keyed by schedule id), while the collected side has nowhere to live
   * and loan-level `PenaltyWaiver` rows cannot be attributed back to an
   * installment. Wiring this tier up without a collected-to-date figure
   * would re-collect the same penalty on every partial payment — the exact
   * defect `repair-payment-allocations.ts` exists to clean up after.
   */
  penaltyDue?: MoneyInput;
  penaltyPaid?: MoneyInput;
}

export interface InstallmentAllocation {
  /** Index into the `installments` array this slice was applied to. */
  index: number;
  interest: number;
  principal: number;
  /**
   * Present only when this slice actually carried fee or penalty money.
   *
   * Omitted rather than zero so that a loan on `INTEREST_PRINCIPAL` gets
   * back exactly the object it got back before §26 — same keys, same
   * values. That equality is asserted by the allocation golden tests, and
   * it is what makes "existing loans are untouched" checkable rather than
   * merely claimed. Read them as `slice.fee ?? 0`.
   */
  fee?: number;
  penalty?: number;
}

export interface PaymentAllocation {
  /** Total interest applied across all installments. */
  interest: number;
  /** Total principal applied across all installments. */
  principal: number;
  /**
   * Totals for the two tiers §26 added. Present only when the allocation
   * actually applied money to them — the same rule as `InstallmentAllocation`:
   * a tier appears in the result when it carried money, and not otherwise.
   *
   * That rule is not cosmetic. It is what makes an allocation on
   * `INTEREST_PRINCIPAL` deep-equal to the pre-§26 result, key for key, so
   * the golden tests committed before this change could be re-run against
   * it without a single edit. Read them as `allocation.fees ?? 0`.
   */
  fees?: number;
  penalties?: number;
  /** Amount left over after every installment is fully settled. */
  overpayment: number;
  /** Per-installment slices, in the order the installments were passed. */
  perInstallment: InstallmentAllocation[];
}

/** Running centavo totals, one per tier. */
type TierTotals = Record<AllocationTier, number>;

/**
 * Split a flat payment across the open installments in order, applying the
 * tiers within each installment in the order the loan was written under.
 *
 * ── Order ───────────────────────────────────────────────────────────────
 *
 * The walk is installment-major: every tier of installment 1, then every
 * tier of installment 2. It is NOT tier-major — a payment does not clear
 * the penalties on the whole schedule before touching installment 1's
 * principal. That matters and is a deliberate choice: installment-major is
 * what the pre-§26 code did (interest then principal, per installment), it
 * is the conventional servicing behaviour, and tier-major would make a
 * partial payment from a borrower in arrears settle charges across every
 * overdue installment before reducing any debt at all.
 *
 * `order` defaults to `INTEREST_PRINCIPAL`, which is what every loan on the
 * books before §26 pays under. Callers that hold a loan's snapshotted order
 * pass it; callers that do not get the legacy behaviour, unchanged.
 *
 * ── Arithmetic ──────────────────────────────────────────────────────────
 *
 * Everything runs in integer centavos (§11). Amounts arrive as
 * `Prisma.Decimal`, decimal strings or numbers and are parsed from their
 * decimal text, so no value is ever routed through a float. The figures
 * handed back are the same 2-decimal doubles as before — `centavos / 100`
 * is bit-for-bit the division `round2` ended with.
 *
 * Allocation runs against each installment's *remaining* due — e.g.
 * `interestDue - interestPaid`. That is what makes repeated partial
 * payments add up correctly: without the paid-to-date figures a borrower
 * paying one installment in five slices would have interest recognized five
 * times over. Each remaining balance is clamped at 0, so an over-credited
 * row (repair scripts, manual edits) cannot hand back negative headroom and
 * silently inflate the next installment's slice.
 *
 * `perInstallment` carries the slice applied to each installment so the
 * caller can persist the progress; installments that received nothing are
 * omitted. Anything left after every installment is settled comes back as
 * `overpayment` — the caller books that as a customer advance, not principal.
 *
 * ── The FEES and PENALTIES tiers are inert today ────────────────────────
 *
 * Both resolve to a zero balance on every installment, because neither is
 * modelled as a payable per-installment amount (see `InstallmentDue`).
 * `FEES_PENALTIES_INTEREST_PRINCIPAL` therefore allocates identically to
 * `INTEREST_PRINCIPAL` right now — which is the safe place for this to
 * land, since it means selecting §26's order cannot move a peso until the
 * balances behind it are real. Closing the penalty half needs a
 * collected-to-date figure per installment and a rule attributing
 * loan-level waivers back to installments; neither is invented here.
 */
export function allocatePayment(
  amount: MoneyInput,
  installments: InstallmentDue[],
  order: PaymentAllocationOrder = DEFAULT_ALLOCATION_ORDER,
): PaymentAllocation {
  const tiers = ALLOCATION_ORDERS[order];
  let remaining = toCentavos(amount);
  const totals: TierTotals = {
    FEES: 0,
    PENALTIES: 0,
    INTEREST: 0,
    PRINCIPAL: 0,
  };
  const perInstallment: InstallmentAllocation[] = [];

  for (let index = 0; index < installments.length; index++) {
    if (remaining <= 0) break;
    const inst = installments[index]!;

    const open = openByTier(inst);
    const part: TierTotals = {
      FEES: 0,
      PENALTIES: 0,
      INTEREST: 0,
      PRINCIPAL: 0,
    };

    let touched = false;
    for (const tier of tiers) {
      const take = Math.min(remaining, open[tier]);
      if (take <= 0) continue;
      part[tier] = take;
      totals[tier] += take;
      remaining -= take;
      touched = true;
      if (remaining <= 0) break;
    }

    if (!touched) continue;
    perInstallment.push(slice(index, part));
  }

  const out: PaymentAllocation = {
    interest: fromCentavos(totals.INTEREST),
    principal: fromCentavos(totals.PRINCIPAL),
    overpayment: fromCentavos(remaining),
    perInstallment,
  };
  if (totals.FEES > 0) out.fees = fromCentavos(totals.FEES);
  if (totals.PENALTIES > 0) out.penalties = fromCentavos(totals.PENALTIES);
  return out;
}

/** What is still owed on this installment, per tier, in centavos, clamped at 0. */
function openByTier(inst: InstallmentDue): TierTotals {
  const owed = (due: MoneyInput | undefined, paid: MoneyInput | undefined) =>
    Math.max(0, toCentavos(due ?? 0) - toCentavos(paid ?? 0));
  return {
    FEES: owed(inst.feeDue, inst.feePaid),
    PENALTIES: owed(inst.penaltyDue, inst.penaltyPaid),
    INTEREST: owed(inst.interestDue, inst.interestPaid),
    PRINCIPAL: owed(inst.principalDue, inst.principalPaid),
  };
}

/**
 * Builds one `perInstallment` entry. `interest` and `principal` are always
 * present — they always were — while `fee` and `penalty` appear only when
 * non-zero, so a legacy-order allocation is indistinguishable from the
 * pre-§26 output.
 */
function slice(index: number, part: TierTotals): InstallmentAllocation {
  const out: InstallmentAllocation = {
    index,
    interest: fromCentavos(part.INTEREST),
    principal: fromCentavos(part.PRINCIPAL),
  };
  if (part.FEES > 0) out.fee = fromCentavos(part.FEES);
  if (part.PENALTIES > 0) out.penalty = fromCentavos(part.PENALTIES);
  return out;
}

// ─── Cooperative posting helpers ─────────────────────────────────────────

/**
 * Member contribution — one row may credit up to three buckets at once.
 *
 *   Dr Cash                         total
 *     Cr Capital Build-Up           capitalBuildUp
 *     Cr Mortuary Fund Payable      mortuaryFund
 *     Cr Emergency Fund Payable     emergencyFund
 *
 * Lines with a zero amount are omitted — buildEntry filters them out.
 */
export function contributionEntry(args: {
  contributionId: string;
  customerName: string;
  capitalBuildUp: number;
  mortuaryFund: number;
  emergencyFund: number;
  contributedAt: Date;
}): JournalEntryInput | null {
  const total = round2(
    args.capitalBuildUp + args.mortuaryFund + args.emergencyFund,
  );
  if (total <= 0) return null;
  const lines: JournalLineInput[] = [
    {
      accountCode: ACCOUNT_CODES.CASH,
      debit: total,
      credit: 0,
      memo: `Contribution — ${args.customerName}`,
    },
  ];
  if (args.capitalBuildUp > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.CAPITAL_BUILD_UP,
      debit: 0,
      credit: round2(args.capitalBuildUp),
      memo: "CBU",
    });
  }
  if (args.mortuaryFund > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.MORTUARY_FUND,
      debit: 0,
      credit: round2(args.mortuaryFund),
      memo: "Mortuary fund",
    });
  }
  if (args.emergencyFund > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.EMERGENCY_FUND,
      debit: 0,
      credit: round2(args.emergencyFund),
      memo: "Emergency fund",
    });
  }
  return buildEntry({
    entryDate: args.contributedAt,
    source: "COOP_CONTRIBUTION",
    sourceRefType: "Contribution",
    sourceRefId: args.contributionId,
    memo: `Contribution — ${args.customerName}`,
    lines,
  });
}

/**
 * Savings deposit / withdrawal.
 *
 *   DEPOSIT:    Dr Cash             | Cr Members Savings Payable
 *   WITHDRAWAL: Dr Members Savings  | Cr Cash
 */
export function savingsEntry(args: {
  txnId: string;
  customerName: string;
  amount: number;
  kind: "DEPOSIT" | "WITHDRAWAL";
  txnDate: Date;
}): JournalEntryInput | null {
  const amount = round2(args.amount);
  if (amount <= 0) return null;
  const isDeposit = args.kind === "DEPOSIT";
  return buildEntry({
    entryDate: args.txnDate,
    source: "COOP_SAVINGS",
    sourceRefType: "SavingsTransaction",
    sourceRefId: args.txnId,
    memo: `Savings ${args.kind.toLowerCase()} — ${args.customerName}`,
    lines: isDeposit
      ? [
          { accountCode: ACCOUNT_CODES.CASH, debit: amount, credit: 0 },
          {
            accountCode: ACCOUNT_CODES.MEMBERS_SAVINGS,
            debit: 0,
            credit: amount,
          },
        ]
      : [
          {
            accountCode: ACCOUNT_CODES.MEMBERS_SAVINGS,
            debit: amount,
            credit: 0,
          },
          { accountCode: ACCOUNT_CODES.CASH, debit: 0, credit: amount },
        ],
  });
}

/**
 * Generic fund inflow — credits the bucket identified by `sourceOfFunds`.
 *
 *   Dr Cash                       amount
 *     Cr [bucket-mapped account]  amount
 */
export function fundTransactionEntry(args: {
  txnId: string;
  sourceOfFunds: string;
  amount: number;
  memo?: string;
  txnDate: Date;
}): JournalEntryInput | null {
  const amount = round2(args.amount);
  if (amount <= 0) return null;
  return buildEntry({
    entryDate: args.txnDate,
    source: "COOP_FUND_IN",
    sourceRefType: "FundTransaction",
    sourceRefId: args.txnId,
    memo: args.memo ?? `Fund inflow — ${args.sourceOfFunds}`,
    lines: [
      { accountCode: ACCOUNT_CODES.CASH, debit: amount, credit: 0 },
      {
        accountCode: bucketToAccount(args.sourceOfFunds),
        debit: 0,
        credit: amount,
      },
    ],
  });
}

/**
 * Fund withdrawal — debits the bucket and credits cash.
 *
 *   Dr [bucket-mapped account]  amount
 *     Cr Cash                    amount
 */
export function fundWithdrawalEntry(args: {
  withdrawalId: string;
  sourceOfFunds: string;
  amount: number;
  memo?: string;
  txnDate: Date;
}): JournalEntryInput | null {
  const amount = round2(args.amount);
  if (amount <= 0) return null;
  return buildEntry({
    entryDate: args.txnDate,
    source: "COOP_FUND_OUT",
    sourceRefType: "FundWithdrawal",
    sourceRefId: args.withdrawalId,
    memo: args.memo ?? `Fund withdrawal — ${args.sourceOfFunds}`,
    lines: [
      {
        accountCode: bucketToAccount(args.sourceOfFunds),
        debit: amount,
        credit: 0,
      },
      { accountCode: ACCOUNT_CODES.CASH, debit: 0, credit: amount },
    ],
  });
}

/**
 * Expense — debits Operating Expense, credits the fund the cash came from.
 *
 *   Dr Operating Expense        amount
 *     Cr [bucket-mapped]         amount
 *
 * For "CASH" / "GENERAL" buckets that maps back to the cash account.
 */
export function expenseEntry(args: {
  expenseId: string;
  type: string;
  amount: number;
  sourceOfFunds: string;
  txnDate: Date;
}): JournalEntryInput | null {
  const amount = round2(args.amount);
  if (amount <= 0) return null;
  return buildEntry({
    entryDate: args.txnDate,
    source: "COOP_EXPENSE",
    sourceRefType: "Expense",
    sourceRefId: args.expenseId,
    memo: `${args.type} (${args.sourceOfFunds})`,
    lines: [
      {
        accountCode: ACCOUNT_CODES.OPERATING_EXPENSE,
        debit: amount,
        credit: 0,
      },
      {
        accountCode: bucketToAccount(args.sourceOfFunds),
        debit: 0,
        credit: amount,
      },
    ],
  });
}

/**
 * Other income — credits the income account, debits the destination
 * bucket (or cash for GENERAL).
 *
 *   Dr [bucket-mapped]    amount     (= Cash for GENERAL)
 *     Cr Other Income      amount
 */
export function otherIncomeEntry(args: {
  incomeId: string;
  type: string;
  amount: number;
  sourceTo: string;
  txnDate: Date;
}): JournalEntryInput | null {
  const amount = round2(args.amount);
  if (amount <= 0) return null;
  // Treat sourceTo == "OTHER_INCOME" specially to avoid a self-loop;
  // route to cash in that case.
  const destination =
    args.sourceTo.toUpperCase() === "OTHER_INCOME"
      ? ACCOUNT_CODES.CASH
      : bucketToAccount(args.sourceTo);
  return buildEntry({
    entryDate: args.txnDate,
    source: "COOP_OTHER_INCOME",
    sourceRefType: "OtherIncome",
    sourceRefId: args.incomeId,
    memo: `${args.type} → ${args.sourceTo}`,
    lines: [
      { accountCode: destination, debit: amount, credit: 0 },
      { accountCode: ACCOUNT_CODES.OTHER_INCOME, debit: 0, credit: amount },
    ],
  });
}

/**
 * Big Brother capital injection — booked as a liability (returnable at
 * period end). To convert to equity (grant) post a manual adjustment at
 * period-end.
 *
 *   Dr Cash                       capital
 *     Cr Big Brother Capital      capital
 */
export function bigBrotherEntry(args: {
  accountId: string;
  name: string;
  capital: number;
  receivedAt: Date;
}): JournalEntryInput | null {
  const amount = round2(args.capital);
  if (amount <= 0) return null;
  return buildEntry({
    entryDate: args.receivedAt,
    source: "COOP_BIG_BROTHER",
    sourceRefType: "BigBrotherAccount",
    sourceRefId: args.accountId,
    memo: `Big Brother capital — ${args.name}`,
    lines: [
      { accountCode: ACCOUNT_CODES.CASH, debit: amount, credit: 0 },
      {
        accountCode: ACCOUNT_CODES.BIG_BROTHER_CAPITAL,
        debit: 0,
        credit: amount,
      },
    ],
  });
}
