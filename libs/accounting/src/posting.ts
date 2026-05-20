/**
 * Posting helpers. Pure shape — these functions describe the journal lines
 * a given business event should produce. Persistence is the caller's job
 * (AccountingRepository.post inside a Prisma transaction).
 *
 * Rule of the system: every entry must balance (sum debits == sum credits).
 * `buildEntry` enforces it.
 */

import { ACCOUNT_CODES, bucketToAccount } from './chart.js';

export interface JournalLineInput {
  /** Account code from the chart (resolved to id by the repository). */
  accountCode: string;
  debit: number;
  credit: number;
  memo?: string;
}

export type JournalSourceKind =
  | 'MANUAL'
  | 'LOAN_DISBURSEMENT'
  | 'LOAN_PAYMENT'
  | 'REVERSAL'
  | 'ADJUSTMENT'
  | 'INTEREST_ACCRUAL'
  | 'LATE_FEE_ACCRUAL'
  | 'ECL_PROVISION'
  | 'COOP_CONTRIBUTION'
  | 'COOP_SAVINGS'
  | 'COOP_FUND_IN'
  | 'COOP_FUND_OUT'
  | 'COOP_EXPENSE'
  | 'COOP_OTHER_INCOME'
  | 'COOP_BIG_BROTHER';

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
  const lines = input.lines
    .map((l) => ({ ...l, debit: round2(l.debit), credit: round2(l.credit) }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.length < 2) {
    throw new Error('A journal entry needs at least two lines.');
  }
  for (const line of lines) {
    if (line.debit > 0 && line.credit > 0) {
      throw new Error(`Line for ${line.accountCode} has both debit and credit.`);
    }
    if (line.debit < 0 || line.credit < 0) {
      throw new Error(`Line for ${line.accountCode} has a negative amount.`);
    }
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
    source: 'LOAN_DISBURSEMENT',
    sourceRefType: 'LoanApplication',
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
    source: 'MANUAL',
    sourceRefType: 'LoanPreTermination',
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
 * Loan payment. Allocation arrives split into interest + principal portions
 * (the loan repository computes this from the schedule).
 *   Dr Cash               total
 *     Cr Interest Income  interestPortion
 *     Cr Loans Receivable principalPortion
 */
export function loanPaymentEntry(args: {
  loanId: string;
  loanNumber: string;
  paymentId: string;
  amount: number;
  interestPortion: number;
  principalPortion: number;
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
  return buildEntry({
    entryDate: args.paidOn,
    source: 'LOAN_PAYMENT',
    sourceRefType: 'LoanPayment',
    sourceRefId: args.paymentId,
    memo: `Payment on ${args.loanNumber}`,
    lines,
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
    source: 'INTEREST_ACCRUAL',
    sourceRefType: 'LoanScheduleAccrual',
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
    source: 'LATE_FEE_ACCRUAL',
    sourceRefType: 'LoanScheduleLateFee',
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
  const memo = args.memo ?? `ECL provision movement (${isIncrease ? 'increase' : 'release'})`;
  return buildEntry({
    entryDate: args.postedAt,
    source: 'ECL_PROVISION',
    sourceRefType: 'EclRun',
    sourceRefId: args.eclRunId,
    memo,
    lines: isIncrease
      ? [
          {
            accountCode: ACCOUNT_CODES.IMPAIRMENT_LOSS,
            debit: amount,
            credit: 0,
            memo: 'ECL increase',
          },
          {
            accountCode: ACCOUNT_CODES.ALLOWANCE_FOR_DOUBTFUL,
            debit: 0,
            credit: amount,
            memo: 'ECL allowance build',
          },
        ]
      : [
          {
            accountCode: ACCOUNT_CODES.ALLOWANCE_FOR_DOUBTFUL,
            debit: amount,
            credit: 0,
            memo: 'ECL allowance release',
          },
          {
            accountCode: ACCOUNT_CODES.IMPAIRMENT_LOSS,
            debit: 0,
            credit: amount,
            memo: 'ECL write-back',
          },
        ],
  });
}

/**
 * Split a flat payment amount between interest and principal using the
 * remaining installments in order. Interest comes first within each
 * installment (standard amortization).
 *
 * Returns the portions actually applied; the caller can detect "overpayment"
 * if `interest + principal < amount`.
 */
export function allocatePayment(
  amount: number,
  installments: Array<{ interestDue: number; principalDue: number }>,
): { interest: number; principal: number; overpayment: number } {
  let remaining = round2(amount);
  let interest = 0;
  let principal = 0;
  for (const inst of installments) {
    if (remaining <= 0) break;
    const interestPart = Math.min(remaining, round2(inst.interestDue));
    remaining = round2(remaining - interestPart);
    interest = round2(interest + interestPart);

    if (remaining <= 0) break;
    const principalPart = Math.min(remaining, round2(inst.principalDue));
    remaining = round2(remaining - principalPart);
    principal = round2(principal + principalPart);
  }
  return { interest, principal, overpayment: round2(remaining) };
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
  const total = round2(args.capitalBuildUp + args.mortuaryFund + args.emergencyFund);
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
      memo: 'CBU',
    });
  }
  if (args.mortuaryFund > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.MORTUARY_FUND,
      debit: 0,
      credit: round2(args.mortuaryFund),
      memo: 'Mortuary fund',
    });
  }
  if (args.emergencyFund > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.EMERGENCY_FUND,
      debit: 0,
      credit: round2(args.emergencyFund),
      memo: 'Emergency fund',
    });
  }
  return buildEntry({
    entryDate: args.contributedAt,
    source: 'COOP_CONTRIBUTION',
    sourceRefType: 'Contribution',
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
  kind: 'DEPOSIT' | 'WITHDRAWAL';
  txnDate: Date;
}): JournalEntryInput | null {
  const amount = round2(args.amount);
  if (amount <= 0) return null;
  const isDeposit = args.kind === 'DEPOSIT';
  return buildEntry({
    entryDate: args.txnDate,
    source: 'COOP_SAVINGS',
    sourceRefType: 'SavingsTransaction',
    sourceRefId: args.txnId,
    memo: `Savings ${args.kind.toLowerCase()} — ${args.customerName}`,
    lines: isDeposit
      ? [
          { accountCode: ACCOUNT_CODES.CASH,            debit: amount, credit: 0 },
          { accountCode: ACCOUNT_CODES.MEMBERS_SAVINGS, debit: 0,      credit: amount },
        ]
      : [
          { accountCode: ACCOUNT_CODES.MEMBERS_SAVINGS, debit: amount, credit: 0 },
          { accountCode: ACCOUNT_CODES.CASH,            debit: 0,      credit: amount },
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
    source: 'COOP_FUND_IN',
    sourceRefType: 'FundTransaction',
    sourceRefId: args.txnId,
    memo: args.memo ?? `Fund inflow — ${args.sourceOfFunds}`,
    lines: [
      { accountCode: ACCOUNT_CODES.CASH,                       debit: amount, credit: 0 },
      { accountCode: bucketToAccount(args.sourceOfFunds),       debit: 0,      credit: amount },
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
    source: 'COOP_FUND_OUT',
    sourceRefType: 'FundWithdrawal',
    sourceRefId: args.withdrawalId,
    memo: args.memo ?? `Fund withdrawal — ${args.sourceOfFunds}`,
    lines: [
      { accountCode: bucketToAccount(args.sourceOfFunds),       debit: amount, credit: 0 },
      { accountCode: ACCOUNT_CODES.CASH,                       debit: 0,      credit: amount },
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
    source: 'COOP_EXPENSE',
    sourceRefType: 'Expense',
    sourceRefId: args.expenseId,
    memo: `${args.type} (${args.sourceOfFunds})`,
    lines: [
      { accountCode: ACCOUNT_CODES.OPERATING_EXPENSE,           debit: amount, credit: 0 },
      { accountCode: bucketToAccount(args.sourceOfFunds),       debit: 0,      credit: amount },
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
    args.sourceTo.toUpperCase() === 'OTHER_INCOME'
      ? ACCOUNT_CODES.CASH
      : bucketToAccount(args.sourceTo);
  return buildEntry({
    entryDate: args.txnDate,
    source: 'COOP_OTHER_INCOME',
    sourceRefType: 'OtherIncome',
    sourceRefId: args.incomeId,
    memo: `${args.type} → ${args.sourceTo}`,
    lines: [
      { accountCode: destination,                  debit: amount, credit: 0 },
      { accountCode: ACCOUNT_CODES.OTHER_INCOME,   debit: 0,      credit: amount },
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
    source: 'COOP_BIG_BROTHER',
    sourceRefType: 'BigBrotherAccount',
    sourceRefId: args.accountId,
    memo: `Big Brother capital — ${args.name}`,
    lines: [
      { accountCode: ACCOUNT_CODES.CASH,                debit: amount, credit: 0 },
      { accountCode: ACCOUNT_CODES.BIG_BROTHER_CAPITAL, debit: 0,      credit: amount },
    ],
  });
}
