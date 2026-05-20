/**
 * Accounting repository — persistence for the general ledger.
 *
 * The hot path is `postEntry`, which:
 *   1. Resolves account codes to ids (one query per call, cached by code).
 *   2. Allocates the next "JE-YYYY-NNNNNN" number.
 *   3. Validates that debits == credits (the lib also enforces this).
 *   4. Inserts the entry + lines.
 *
 * `postIfAbsent` is the idempotent variant used by auto-posting — if a
 * journal entry already exists for the given (source, sourceRefId) it
 * returns the existing row instead of double-posting.
 */

import {
  type AccountTypeCode,
  type ChartAccount,
  DEFAULT_CHART_OF_ACCOUNTS,
  type JournalEntryInput,
  type LedgerLineInput,
  type NormalBalanceCode,
  type PeriodKey,
  buildAgingReport,
  buildBalanceSheet,
  buildIncomeStatement,
  buildTrialBalance,
  keyOf,
  periodFor,
} from '@loan/accounting';
import type {
  Account,
  AccountingPeriod,
  JournalEntry,
  Prisma,
  PrismaClient,
} from '@prisma/client';

type Tx = Prisma.TransactionClient | PrismaClient;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AccountCreateInput {
  code: string;
  name: string;
  type: AccountTypeCode;
  normalBalance: NormalBalanceCode;
  description?: string;
}

export interface PostEntryOptions {
  postedById: string;
  /** Override prisma client (e.g. inside a parent transaction). */
  tx?: Tx;
}

export class AccountingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Chart of accounts ────────────────────────────────────────────────

  listAccounts(): Promise<Account[]> {
    return this.prisma.account.findMany({ orderBy: { code: 'asc' } });
  }

  findAccountByCode(code: string): Promise<Account | null> {
    return this.prisma.account.findUnique({ where: { code } });
  }

  createAccount(input: AccountCreateInput): Promise<Account> {
    return this.prisma.account.create({
      data: {
        code: input.code,
        name: input.name,
        type: input.type,
        normalBalance: input.normalBalance,
        description: input.description,
      },
    });
  }

  /** Idempotent seed — adds any missing system accounts, never deletes. */
  async seedDefaultChart(
    chart: ChartAccount[] = DEFAULT_CHART_OF_ACCOUNTS,
  ): Promise<{ created: number; existing: number }> {
    let created = 0;
    let existing = 0;
    for (const a of chart) {
      const result = await this.prisma.account.upsert({
        where: { code: a.code },
        create: {
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
          description: a.description,
          system: a.system ?? false,
        },
        update: {},
      });
      if (result.createdAt.getTime() === result.updatedAt.getTime()) created += 1;
      else existing += 1;
    }
    return { created, existing };
  }

  // ─── Journal entries ──────────────────────────────────────────────────

  listEntries(filter?: {
    from?: Date;
    to?: Date;
    source?: string;
    sourceRefId?: string;
  }) {
    return this.prisma.journalEntry.findMany({
      where: {
        entryDate: {
          gte: filter?.from,
          lte: filter?.to,
        },
        source: filter?.source as never,
        sourceRefId: filter?.sourceRefId,
      },
      include: { lines: { include: { account: true } }, postedBy: { select: { id: true, name: true } } },
      orderBy: [{ entryDate: 'desc' }, { number: 'desc' }],
      take: 500,
    });
  }

  findEntryById(id: string) {
    return this.prisma.journalEntry.findUnique({
      where: { id },
      include: {
        lines: { include: { account: true } },
        postedBy: { select: { id: true, name: true } },
      },
    });
  }

  /**
   * Post a journal entry. Resolves account codes to ids, locates (or
   * creates) the accounting period that owns `entryDate`, refuses if
   * that period is CLOSED, allocates the next entry number, and inserts
   * entry + lines atomically.
   */
  async postEntry(input: JournalEntryInput, opts: PostEntryOptions): Promise<JournalEntry> {
    const tx = opts.tx ?? this.prisma;
    const codes = [...new Set(input.lines.map((l) => l.accountCode))];
    const accounts = await tx.account.findMany({ where: { code: { in: codes } } });
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    for (const code of codes) {
      const acc = byCode.get(code);
      if (!acc) throw new Error(`Unknown account code "${code}".`);
      if (!acc.active) throw new Error(`Account ${code} is inactive.`);
    }

    const period = await this.ensurePeriodForDate(tx, input.entryDate);
    if (period.status === 'CLOSED') {
      const err = new Error(
        `Cannot post: accounting period ${keyOf({ year: period.year, month: period.month })} is closed.`,
      );
      (err as Error & { code?: string }).code = 'PERIOD_CLOSED';
      throw err;
    }

    const number = await this.nextEntryNumber(tx, input.entryDate);
    return tx.journalEntry.create({
      data: {
        number,
        entryDate: input.entryDate,
        memo: input.memo,
        source: input.source as never,
        sourceRefType: input.sourceRefType,
        sourceRefId: input.sourceRefId,
        postedById: opts.postedById,
        periodId: period.id,
        lines: {
          create: input.lines.map((l) => ({
            accountId: byCode.get(l.accountCode)!.id,
            debit: l.debit,
            credit: l.credit,
            memo: l.memo,
          })),
        },
      },
    });
  }

  // ─── Accounting periods ──────────────────────────────────────────────

  listPeriods(): Promise<AccountingPeriod[]> {
    return this.prisma.accountingPeriod.findMany({
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 60,
    });
  }

  findPeriod(year: number, month: number): Promise<AccountingPeriod | null> {
    return this.prisma.accountingPeriod.findUnique({
      where: { year_month: { year, month } },
    });
  }

  /** Idempotent — creates (year, month) as OPEN if it doesn't exist. */
  async ensurePeriod(year: number, month: number, tx?: Tx): Promise<AccountingPeriod> {
    const client = tx ?? this.prisma;
    return client.accountingPeriod.upsert({
      where: { year_month: { year, month } },
      create: { year, month, status: 'OPEN' },
      update: {},
    });
  }

  async closePeriod(year: number, month: number, userId: string): Promise<AccountingPeriod> {
    const p = await this.ensurePeriod(year, month);
    if (p.status === 'CLOSED') return p;
    return this.prisma.accountingPeriod.update({
      where: { id: p.id },
      data: { status: 'CLOSED', closedAt: new Date(), closedById: userId },
    });
  }

  async reopenPeriod(year: number, month: number): Promise<AccountingPeriod> {
    const p = await this.findPeriod(year, month);
    if (!p) throw new Error(`Period ${year}-${month} does not exist.`);
    if (p.status === 'OPEN') return p;
    return this.prisma.accountingPeriod.update({
      where: { id: p.id },
      data: { status: 'OPEN', closedAt: null, closedById: null },
    });
  }

  private async ensurePeriodForDate(tx: Tx, date: Date): Promise<AccountingPeriod> {
    const k: PeriodKey = periodFor(date);
    return this.ensurePeriod(k.year, k.month, tx);
  }

  // ─── Reversals ───────────────────────────────────────────────────────

  /**
   * Reverse a journal entry by posting an opposite-direction entry and
   * linking the two via `reversedById`.
   *
   * The reversal hits the *current* period (today's date), not the original's
   * — this is standard accounting practice: closed periods stay closed, the
   * correction lands in the open period. Throws if the original is already
   * reversed or if today's period is somehow closed.
   *
   * Idempotent: re-running on a reversed entry returns the existing reversal.
   */
  async reverseEntry(
    entryId: string,
    opts: PostEntryOptions & { memo?: string },
  ): Promise<{ original: JournalEntry; reversal: JournalEntry; created: boolean }> {
    const tx = opts.tx ?? this.prisma;
    const original = await tx.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: { include: { account: true } } },
    });
    if (!original) throw new Error(`Journal entry ${entryId} not found.`);

    if (original.reversedById) {
      const existing = await tx.journalEntry.findUnique({
        where: { id: original.reversedById },
      });
      if (existing) return { original, reversal: existing, created: false };
    }
    if (original.source === 'REVERSAL') {
      throw new Error('Cannot reverse a reversal — post a new entry instead.');
    }

    const today = new Date();
    const period = await this.ensurePeriodForDate(tx, today);
    if (period.status === 'CLOSED') {
      throw new Error(
        `Cannot post reversal: current period ${keyOf({ year: period.year, month: period.month })} is closed.`,
      );
    }

    const number = await this.nextEntryNumber(tx, today);
    const reversal = await tx.journalEntry.create({
      data: {
        number,
        entryDate: today,
        memo: opts.memo ?? `Reversal of ${original.number}`,
        source: 'REVERSAL' as never,
        sourceRefType: 'JournalEntry',
        sourceRefId: original.id,
        postedById: opts.postedById,
        periodId: period.id,
        lines: {
          create: original.lines.map((l) => ({
            accountId: l.accountId,
            debit: Number(l.credit),  // swap
            credit: Number(l.debit),  // swap
            memo: l.memo ? `Reversal: ${l.memo}` : undefined,
          })),
        },
      },
    });

    await tx.journalEntry.update({
      where: { id: original.id },
      data: { reversedById: reversal.id },
    });
    return { original, reversal, created: true };
  }

  /** Reverse many entries in one go. Per-entry failures are reported. */
  async reverseEntriesBulk(
    entryIds: string[],
    opts: PostEntryOptions & { memoTemplate?: string },
  ): Promise<
    Array<{
      entryId: string;
      ok: boolean;
      reversalId?: string;
      error?: string;
    }>
  > {
    const out: Array<{
      entryId: string;
      ok: boolean;
      reversalId?: string;
      error?: string;
    }> = [];
    for (const id of entryIds) {
      try {
        const result = await this.reverseEntry(id, opts);
        out.push({ entryId: id, ok: true, reversalId: result.reversal.id });
      } catch (err) {
        out.push({ entryId: id, ok: false, error: (err as Error).message });
      }
    }
    return out;
  }

  // ─── Portfolio analytics ─────────────────────────────────────────────

  /**
   * Snapshot for the analytics dashboard: outstanding principal, total
   * active loans, originations YTD, and Portfolio at Risk percentages at
   * 30/60/90 days. NPL = `outstanding overdue 90+ days / total outstanding`.
   */
  async portfolioSummary(asOf: Date = new Date()): Promise<{
    asOf: string;
    activeLoans: number;
    totalOutstanding: number;
    originatedYtd: { count: number; principal: number };
    par30: number;
    par60: number;
    par90: number;
    nplRatio: number;
    cash: number;
    receivable: number;
  }> {
    const dayMs = 86_400_000;
    const open = await this.prisma.loanSchedule.findMany({
      where: {
        paidInFullAt: null,
        loan: { status: { in: ['ACTIVE', 'DISBURSED', 'DEFAULTED'] } },
      },
      include: { loan: { select: { id: true } } },
    });

    const loanOutstanding = new Map<string, number>();
    const loanMaxOverdueDays = new Map<string, number>();
    for (const s of open) {
      const remaining = Number(s.totalDue) - Number(s.principalPaid);
      loanOutstanding.set(
        s.loan.id,
        (loanOutstanding.get(s.loan.id) ?? 0) + remaining,
      );
      const days = Math.max(
        0,
        Math.floor((asOf.getTime() - s.dueDate.getTime()) / dayMs),
      );
      if (days > (loanMaxOverdueDays.get(s.loan.id) ?? 0)) {
        loanMaxOverdueDays.set(s.loan.id, days);
      }
    }

    let totalOutstanding = 0;
    let par30 = 0;
    let par60 = 0;
    let par90 = 0;
    for (const [loanId, balance] of loanOutstanding) {
      totalOutstanding += balance;
      const od = loanMaxOverdueDays.get(loanId) ?? 0;
      if (od > 90) par90 += balance;
      if (od > 60) par60 += balance;
      if (od > 30) par30 += balance;
    }

    const year = asOf.getFullYear();
    const yearStart = new Date(year, 0, 1);
    const ytd = await this.prisma.loanApplication.findMany({
      where: {
        disbursedAt: { gte: yearStart, lte: asOf },
      },
      select: { principal: true },
    });
    const ytdPrincipal = ytd.reduce((s, r) => s + Number(r.principal), 0);

    const cashAcc = await this.prisma.account.findUnique({ where: { code: '1000' } });
    const recAcc = await this.prisma.account.findUnique({ where: { code: '1100' } });
    const cashBal = cashAcc ? await this.accountBalance(cashAcc.id, asOf) : 0;
    const recBal = recAcc ? await this.accountBalance(recAcc.id, asOf) : 0;

    return {
      asOf: asOf.toISOString(),
      activeLoans: loanOutstanding.size,
      totalOutstanding: round2(totalOutstanding),
      originatedYtd: { count: ytd.length, principal: round2(ytdPrincipal) },
      par30: round2(par30),
      par60: round2(par60),
      par90: round2(par90),
      nplRatio: totalOutstanding > 0 ? round2(par90 / totalOutstanding) : 0,
      cash: round2(cashBal),
      receivable: round2(recBal),
    };
  }

  /** Monthly originations for charts. Range defaults to last 12 months. */
  async originationsByMonth(
    from: Date,
    to: Date,
  ): Promise<Array<{ month: string; count: number; principal: number }>> {
    const apps = await this.prisma.loanApplication.findMany({
      where: { submittedAt: { gte: from, lte: to } },
      select: { submittedAt: true, principal: true },
    });
    const buckets = new Map<string, { count: number; principal: number }>();
    for (const a of apps) {
      const key = `${a.submittedAt.getFullYear()}-${String(a.submittedAt.getMonth() + 1).padStart(2, '0')}`;
      const cur = buckets.get(key) ?? { count: 0, principal: 0 };
      cur.count += 1;
      cur.principal += Number(a.principal);
      buckets.set(key, cur);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, count: v.count, principal: round2(v.principal) }));
  }

  /**
   * Vintage cohorts: for each origination month, what % of that cohort is
   * now overdue 90+ days? Tells you whether underwriting is improving or
   * drifting over time.
   */
  async vintageCohorts(): Promise<
    Array<{
      vintage: string;
      originated: number;
      currentlyOverdue90Plus: number;
      defaultRate: number;
    }>
  > {
    const today = new Date();
    const oldest = new Date(today);
    oldest.setMonth(today.getMonth() - 24);
    const loans = await this.prisma.loanApplication.findMany({
      where: { submittedAt: { gte: oldest }, status: { not: 'DRAFT' } },
      include: {
        schedule: { where: { paidInFullAt: null } },
      },
    });
    const map = new Map<string, { originated: number; overdue: number }>();
    const dayMs = 86_400_000;
    for (const l of loans) {
      const key = `${l.submittedAt.getFullYear()}-${String(l.submittedAt.getMonth() + 1).padStart(2, '0')}`;
      const cur = map.get(key) ?? { originated: 0, overdue: 0 };
      cur.originated += 1;
      const isOverdue90 = l.schedule.some(
        (s) => (today.getTime() - s.dueDate.getTime()) / dayMs > 90,
      );
      if (isOverdue90) cur.overdue += 1;
      map.set(key, cur);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([vintage, v]) => ({
        vintage,
        originated: v.originated,
        currentlyOverdue90Plus: v.overdue,
        defaultRate: v.originated > 0 ? round2(v.overdue / v.originated) : 0,
      }));
  }

  private async accountBalance(accountId: string, asOf: Date): Promise<number> {
    const lines = await this.prisma.journalLine.findMany({
      where: { accountId, entry: { entryDate: { lte: asOf } } },
      select: { debit: true, credit: true },
    });
    return lines.reduce(
      (s, l) => s + (Number(l.debit) - Number(l.credit)),
      0,
    );
  }

  // ─── Accrual jobs ────────────────────────────────────────────────────

  /**
   * Run monthly interest accrual for every installment falling in the given
   * period. Idempotent — entries are tagged by `LoanScheduleAccrual:<scheduleId>`
   * via postIfAbsent.
   *
   * Posts ONE entry per installment so the books mirror the schedule grain.
   * Skips installments already paid in full or fully accrued.
   */
  async accrueMonthlyInterest(
    period: PeriodKey,
    postedById: string,
  ): Promise<{ posted: number; skipped: number }> {
    const { interestAccrualEntry, periodBounds } = await import('@loan/accounting');
    const { start, endExclusive } = periodBounds(period);

    const installments = await this.prisma.loanSchedule.findMany({
      where: {
        dueDate: { gte: start, lt: endExclusive },
        paidInFullAt: null,
        loan: { status: { in: ['ACTIVE', 'DISBURSED'] } },
      },
      include: { loan: { select: { number: true } } },
    });

    let posted = 0;
    let skipped = 0;
    for (const inst of installments) {
      const interest = Number(inst.interestDue);
      if (interest <= 0) {
        skipped += 1;
        continue;
      }
      const entry = interestAccrualEntry({
        scheduleId: inst.id,
        loanNumber: inst.loan.number,
        installmentNo: inst.installmentNo,
        interest,
        accruedOn: inst.dueDate,
      });
      const result = await this.postIfAbsent(entry, { postedById });
      if (result.created) posted += 1;
      else skipped += 1;
    }
    return { posted, skipped };
  }

  /**
   * Idempotent variant — used by auto-posting. If an entry already exists
   * for (source, sourceRefType, sourceRefId) it is returned as-is, no new
   * entry is posted. Matching includes `sourceRefType` because multiple
   * MANUAL flows (restructure, write-off, pre-term fee) can target the
   * same loan id.
   */
  async postIfAbsent(
    input: JournalEntryInput,
    opts: PostEntryOptions,
  ): Promise<{ entry: JournalEntry; created: boolean }> {
    const tx = opts.tx ?? this.prisma;
    if (input.sourceRefId) {
      const existing = await tx.journalEntry.findFirst({
        where: {
          source: input.source as never,
          sourceRefType: input.sourceRefType ?? null,
          sourceRefId: input.sourceRefId,
        },
      });
      if (existing) return { entry: existing, created: false };
    }
    const entry = await this.postEntry(input, opts);
    return { entry, created: true };
  }

  // ─── Reports ─────────────────────────────────────────────────────────

  async trialBalance(asOf: Date) {
    const lines = await this.ledgerLines({ to: asOf });
    return buildTrialBalance(lines, asOf);
  }

  async incomeStatement(from: Date, to: Date) {
    const lines = await this.ledgerLines({ from, to });
    return buildIncomeStatement(lines, from, to);
  }

  async balanceSheet(asOf: Date) {
    const lines = await this.ledgerLines({ to: asOf });
    return buildBalanceSheet(lines, asOf);
  }

  /** Per-account ledger (chronological). */
  async ledgerFor(accountId: string, from?: Date, to?: Date) {
    const rows = await this.prisma.journalLine.findMany({
      where: {
        accountId,
        entry: { entryDate: { gte: from, lte: to } },
      },
      include: {
        entry: { select: { id: true, number: true, entryDate: true, memo: true, source: true } },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { number: 'asc' } }],
    });
    let running = 0;
    return rows.map((r) => {
      running += Number(r.debit) - Number(r.credit);
      return {
        lineId: r.id,
        entryId: r.entry.id,
        entryNumber: r.entry.number,
        entryDate: r.entry.entryDate,
        source: r.entry.source,
        memo: r.memo ?? r.entry.memo ?? '',
        debit: Number(r.debit),
        credit: Number(r.credit),
        runningBalance: Math.round(running * 100) / 100,
      };
    });
  }

  async loanPortfolioAging(asOf: Date) {
    const rows = await this.prisma.loanSchedule.findMany({
      where: {
        paidInFullAt: null,
        loan: { status: { in: ['ACTIVE', 'DISBURSED', 'DEFAULTED'] } },
      },
      include: {
        loan: {
          select: {
            id: true,
            number: true,
            customer: { select: { firstName: true, lastName: true } },
          },
        },
      },
    });
    return buildAgingReport(
      rows.map((r) => ({
        loanId: r.loan.id,
        loanNumber: r.loan.number,
        customerName: `${r.loan.customer.firstName} ${r.loan.customer.lastName}`,
        installmentNo: r.installmentNo,
        dueDate: r.dueDate,
        totalDue: Number(r.totalDue) - Number(r.principalPaid),
        paidInFullAt: r.paidInFullAt,
      })),
      asOf,
    );
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private async ledgerLines(filter: { from?: Date; to?: Date }): Promise<LedgerLineInput[]> {
    const rows = await this.prisma.journalLine.findMany({
      where: { entry: { entryDate: { gte: filter.from, lte: filter.to } } },
      include: { account: true },
    });
    return rows.map((r) => ({
      accountId: r.accountId,
      accountCode: r.account.code,
      accountName: r.account.name,
      accountType: r.account.type as AccountTypeCode,
      normalBalance: r.account.normalBalance as NormalBalanceCode,
      debit: Number(r.debit),
      credit: Number(r.credit),
    }));
  }

  /** "JE-2026-000123" — same scheme as loan numbers. */
  private async nextEntryNumber(tx: Tx, date: Date): Promise<string> {
    const year = date.getFullYear();
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const last = await tx.journalEntry.findFirst({
      where: { entryDate: { gte: yearStart, lt: yearEnd } },
      orderBy: { number: 'desc' },
    });
    let seq = 1;
    if (last) {
      const match = /JE-\d{4}-(\d+)/.exec(last.number);
      if (match) seq = Number(match[1]) + 1;
    }
    return `JE-${year}-${String(seq).padStart(6, '0')}`;
  }
}
