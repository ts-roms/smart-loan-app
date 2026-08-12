/**
 * Pure report shapes + aggregators. These functions take in raw journal-line
 * rows and produce report rows; the repository runs the SQL/Prisma queries
 * and hands the data over.
 *
 * Keeping these pure lets us unit-test the math without touching a DB.
 */

import type { AccountTypeCode, NormalBalanceCode } from "./chart";

export interface LedgerLineInput {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountTypeCode;
  normalBalance: NormalBalanceCode;
  debit: number;
  credit: number;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountTypeCode;
  debit: number;
  credit: number;
}

export interface TrialBalanceReport {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  inBalance: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Trial balance — net debit/credit per account. Each account ends up on the
 * side that matches its normal balance; the opposite side is shown as 0.
 */
export function buildTrialBalance(
  lines: LedgerLineInput[],
  asOf: Date,
): TrialBalanceReport {
  const byAccount = new Map<string, TrialBalanceRow & { net: number }>();
  for (const l of lines) {
    let row = byAccount.get(l.accountId);
    if (!row) {
      row = {
        accountId: l.accountId,
        code: l.accountCode,
        name: l.accountName,
        type: l.accountType,
        debit: 0,
        credit: 0,
        net: 0,
      };
      byAccount.set(l.accountId, row);
    }
    row.net = round2(row.net + (l.debit - l.credit));
  }

  const rows: TrialBalanceRow[] = [...byAccount.values()]
    .map((r) => {
      if (r.net >= 0) return { ...r, debit: round2(r.net), credit: 0 };
      return { ...r, debit: 0, credit: round2(-r.net) };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return {
    asOf: asOf.toISOString(),
    rows,
    totalDebit,
    totalCredit,
    inBalance: Math.abs(totalDebit - totalCredit) < 0.005,
  };
}

export interface IncomeStatementSection {
  rows: Array<{ code: string; name: string; amount: number }>;
  total: number;
}

export interface IncomeStatementReport {
  from: string;
  to: string;
  income: IncomeStatementSection;
  expense: IncomeStatementSection;
  netIncome: number;
}

/** Income statement — sums income (credit-normal) minus expenses (debit-normal). */
export function buildIncomeStatement(
  lines: LedgerLineInput[],
  from: Date,
  to: Date,
): IncomeStatementReport {
  const byAccount = new Map<
    string,
    { code: string; name: string; type: AccountTypeCode; amount: number }
  >();
  for (const l of lines) {
    if (l.accountType !== "INCOME" && l.accountType !== "EXPENSE") continue;
    const key = l.accountId;
    let row = byAccount.get(key);
    if (!row) {
      row = {
        code: l.accountCode,
        name: l.accountName,
        type: l.accountType,
        amount: 0,
      };
      byAccount.set(key, row);
    }
    // For income (CREDIT-normal): credit increases, debit decreases.
    // For expense (DEBIT-normal): debit increases, credit decreases.
    const delta =
      l.accountType === "INCOME" ? l.credit - l.debit : l.debit - l.credit;
    row.amount = round2(row.amount + delta);
  }

  const incomeRows = [...byAccount.values()]
    .filter((r) => r.type === "INCOME")
    .map((r) => ({ code: r.code, name: r.name, amount: r.amount }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const expenseRows = [...byAccount.values()]
    .filter((r) => r.type === "EXPENSE")
    .map((r) => ({ code: r.code, name: r.name, amount: r.amount }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const incomeTotal = round2(incomeRows.reduce((s, r) => s + r.amount, 0));
  const expenseTotal = round2(expenseRows.reduce((s, r) => s + r.amount, 0));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    income: { rows: incomeRows, total: incomeTotal },
    expense: { rows: expenseRows, total: expenseTotal },
    netIncome: round2(incomeTotal - expenseTotal),
  };
}

export interface BalanceSheetSection {
  rows: Array<{ code: string; name: string; amount: number }>;
  total: number;
}

export interface BalanceSheetReport {
  asOf: string;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  /** Retained earnings = lifetime income - expenses (folded into equity). */
  retainedEarnings: number;
  totalLiabilitiesAndEquity: number;
  inBalance: boolean;
}

/** Balance sheet — assets = liabilities + equity (incl. retained earnings). */
export function buildBalanceSheet(
  lines: LedgerLineInput[],
  asOf: Date,
): BalanceSheetReport {
  type Acc = {
    code: string;
    name: string;
    type: AccountTypeCode;
    amount: number;
  };
  const byAccount = new Map<string, Acc>();
  let retainedEarnings = 0;

  for (const l of lines) {
    if (l.accountType === "INCOME") {
      retainedEarnings = round2(retainedEarnings + (l.credit - l.debit));
      continue;
    }
    if (l.accountType === "EXPENSE") {
      retainedEarnings = round2(retainedEarnings - (l.debit - l.credit));
      continue;
    }
    let row = byAccount.get(l.accountId);
    if (!row) {
      row = {
        code: l.accountCode,
        name: l.accountName,
        type: l.accountType,
        amount: 0,
      };
      byAccount.set(l.accountId, row);
    }
    const delta =
      l.accountType === "ASSET" || l.normalBalance === "DEBIT"
        ? l.debit - l.credit
        : l.credit - l.debit;
    row.amount = round2(row.amount + delta);
  }

  const collect = (type: AccountTypeCode): BalanceSheetSection => {
    const rows = [...byAccount.values()]
      .filter((r) => r.type === type)
      .map((r) => ({ code: r.code, name: r.name, amount: r.amount }))
      .sort((a, b) => a.code.localeCompare(b.code));
    return { rows, total: round2(rows.reduce((s, r) => s + r.amount, 0)) };
  };

  const assets = collect("ASSET");
  const liabilities = collect("LIABILITY");
  const equity = collect("EQUITY");
  const totalLiabilitiesAndEquity = round2(
    liabilities.total + equity.total + retainedEarnings,
  );

  return {
    asOf: asOf.toISOString(),
    assets,
    liabilities,
    equity,
    retainedEarnings,
    totalLiabilitiesAndEquity,
    inBalance: Math.abs(assets.total - totalLiabilitiesAndEquity) < 0.005,
  };
}

// ─── Loan portfolio aging ──────────────────────────────────────────────────

export interface ScheduleRowForAging {
  loanId: string;
  loanNumber: string;
  customerName: string;
  installmentNo: number;
  dueDate: Date;
  totalDue: number;
  paidInFullAt: Date | null;
}

/**
 * Seven bands, not five.
 *
 * `D_90_PLUS` put a loan 95 days late in the same row as one three years
 * gone. Those are not the same asset: the first is a collections problem
 * with a borrower still reachable, the second is a write-off argument,
 * and they provision at different rates. A report that cannot tell them
 * apart cannot support either decision — and roll-rate analysis (§30)
 * needs the finer grain to mean anything at all.
 *
 * The boundaries are §28's: Current, 1–30, 31–60, 61–90, 91–120,
 * 121–180, 180+. 90 days stays a boundary, so the non-performing line is
 * still readable straight off the report; what changes is that
 * everything past it is split rather than pooled.
 *
 * Report-only. Nothing persists a bucket and nothing computes money from
 * one — ECL stages independently on days-past-due (`ecl.repository.ts`),
 * so widening these moves no provision and restates no ledger.
 */
export type AgingBucket =
  | "CURRENT"
  | "D_1_30"
  | "D_31_60"
  | "D_61_90"
  | "D_91_120"
  | "D_121_180"
  | "D_180_PLUS";

export interface AgingRow {
  loanId: string;
  loanNumber: string;
  customerName: string;
  /** Number of unpaid installments past their due date. */
  installmentsOverdue: number;
  /** Total unpaid `totalDue` for the loan (open installments). */
  outstandingBalance: number;
  bucket: AgingBucket;
  /** Days the earliest unpaid installment is past due (0 if current). */
  daysOverdue: number;
}

export interface AgingReport {
  asOf: string;
  rows: AgingRow[];
  totals: Record<AgingBucket, number>;
  totalOutstanding: number;
}

const DAY_MS = 86_400_000;

/**
 * Bands are inclusive of their upper bound, so a loan exactly 90 days
 * overdue is still `D_61_90` and 91 is the first day of the next band.
 * That matches how "90 days past due" is read in practice — the 90th day
 * has not yet passed the threshold.
 *
 * Exported because the aging report is no longer the only caller: the
 * collection priority score (§29) bands DPD too, and a second copy of
 * these thresholds would let the queue and the report disagree about how
 * overdue an account is. One definition, both readers.
 */
export function agingBucketFor(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "CURRENT";
  if (daysOverdue <= 30) return "D_1_30";
  if (daysOverdue <= 60) return "D_31_60";
  if (daysOverdue <= 90) return "D_61_90";
  if (daysOverdue <= 120) return "D_91_120";
  if (daysOverdue <= 180) return "D_121_180";
  return "D_180_PLUS";
}

/** Report order. Exported so the UI cannot invent a different one. */
export const AGING_BUCKETS: readonly AgingBucket[] = [
  "CURRENT",
  "D_1_30",
  "D_31_60",
  "D_61_90",
  "D_91_120",
  "D_121_180",
  "D_180_PLUS",
] as const;

/**
 * The bands that count toward portfolio at risk — everything except
 * CURRENT.
 *
 * Derived rather than listed, so adding a band cannot silently leave it
 * out of the PAR figure. That is the specific way a hand-maintained list
 * goes wrong: the new band renders in the table and quietly stops being
 * counted.
 */
export const OVERDUE_BUCKETS: readonly AgingBucket[] = AGING_BUCKETS.filter(
  (b) => b !== "CURRENT",
);

export function buildAgingReport(
  rows: ScheduleRowForAging[],
  asOf: Date,
): AgingReport {
  const byLoan = new Map<
    string,
    {
      loanId: string;
      loanNumber: string;
      customerName: string;
      outstandingBalance: number;
      earliestOverdue: Date | null;
      installmentsOverdue: number;
    }
  >();
  for (const r of rows) {
    if (r.paidInFullAt) continue;
    let acc = byLoan.get(r.loanId);
    if (!acc) {
      acc = {
        loanId: r.loanId,
        loanNumber: r.loanNumber,
        customerName: r.customerName,
        outstandingBalance: 0,
        earliestOverdue: null,
        installmentsOverdue: 0,
      };
      byLoan.set(r.loanId, acc);
    }
    acc.outstandingBalance = round2(acc.outstandingBalance + r.totalDue);
    if (r.dueDate.getTime() < asOf.getTime()) {
      acc.installmentsOverdue += 1;
      if (!acc.earliestOverdue || r.dueDate < acc.earliestOverdue) {
        acc.earliestOverdue = r.dueDate;
      }
    }
  }

  const out: AgingRow[] = [...byLoan.values()].map((acc) => {
    const daysOverdue = acc.earliestOverdue
      ? Math.max(
          0,
          Math.floor((asOf.getTime() - acc.earliestOverdue.getTime()) / DAY_MS),
        )
      : 0;
    return {
      loanId: acc.loanId,
      loanNumber: acc.loanNumber,
      customerName: acc.customerName,
      outstandingBalance: acc.outstandingBalance,
      installmentsOverdue: acc.installmentsOverdue,
      daysOverdue,
      bucket: agingBucketFor(daysOverdue),
    };
  });

  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<
    AgingBucket,
    number
  >;
  for (const r of out)
    totals[r.bucket] = round2(totals[r.bucket] + r.outstandingBalance);

  out.sort(
    (a, b) =>
      b.daysOverdue - a.daysOverdue || a.loanNumber.localeCompare(b.loanNumber),
  );
  return {
    asOf: asOf.toISOString(),
    rows: out,
    totals,
    totalOutstanding: round2(out.reduce((s, r) => s + r.outstandingBalance, 0)),
  };
}
