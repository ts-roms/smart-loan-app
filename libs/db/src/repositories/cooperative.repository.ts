/**
 * Cooperative module repository.
 *
 * Owns persistence + GL posting for: Contribution, SavingsTransaction,
 * FundTransaction, FundWithdrawal, Expense, OtherIncome, BigBrotherAccount.
 *
 * Posting is auto-fired on create — every monetary row hits the GL via
 * `AccountingRepository.postEntry`. We capture the resulting journal entry
 * id back onto the row for traceability. Failed posts roll back the create
 * inside a Prisma transaction.
 */

import type {
  BigBrotherAccount,
  Contribution,
  Customer,
  Expense,
  FundTransaction,
  FundWithdrawal,
  OtherIncome,
  PrismaClient,
  Prisma,
  SavingsTransaction,
} from "@prisma/client";

import {
  bigBrotherEntry,
  contributionEntry,
  expenseEntry,
  fundTransactionEntry,
  fundWithdrawalEntry,
  otherIncomeEntry,
  savingsEntry,
} from "@loan/accounting";

import { AccountingRepository } from "./accounting.repository";

/** A coop member is just a Customer — see Phase 5 design choice. */
function memberName(
  c: Pick<Customer, "firstName" | "middleName" | "lastName">,
): string {
  return [c.firstName, c.middleName, c.lastName].filter(Boolean).join(" ");
}

export interface ContributionCreateInput {
  customerId: string;
  capitalBuildUp: number;
  mortuaryFund: number;
  emergencyFund: number;
  notes?: string;
  contributedAt?: Date;
  recordedById: string;
}

export interface SavingsCreateInput {
  customerId: string;
  amount: number;
  kind: "DEPOSIT" | "WITHDRAWAL";
  notes?: string;
  txnDate?: Date;
  recordedById: string;
}

export interface FundTransactionCreateInput {
  customerId?: string;
  transactionRef?: string;
  sourceOfFunds: string;
  amount: number;
  txnDate?: Date;
  authorId: string;
  notes?: string;
}

export interface FundWithdrawalCreateInput {
  customerId?: string;
  sourceOfFunds: string;
  amount: number;
  notes?: string;
  txnDate?: Date;
  authorId: string;
}

export interface ExpenseCreateInput {
  type: string;
  amount: number;
  sourceOfFunds: string;
  txnDate?: Date;
  isRecurring?: boolean;
  attachments?: string[];
  notes?: string;
  recordedById: string;
}

export interface OtherIncomeCreateInput {
  type: string;
  amount: number;
  sourceTo: string;
  txnDate?: Date;
  attachments?: string[];
  notes?: string;
  recordedById: string;
}

export interface BigBrotherCreateInput {
  name: string;
  account: string;
  capital: number;
  periodFrom: Date;
  periodTo: Date;
  notes?: string;
  recordedById: string;
}

export class CooperativeRepository {
  private readonly accounting: AccountingRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.accounting = new AccountingRepository(prisma);
  }

  // ─── Contributions ─────────────────────────────────────────────

  listContributions(): Promise<Contribution[]> {
    return this.prisma.contribution.findMany({
      orderBy: { contributedAt: "desc" },
      take: 500,
    });
  }

  async createContribution(
    input: ContributionCreateInput,
  ): Promise<Contribution> {
    const total =
      input.capitalBuildUp + input.mortuaryFund + input.emergencyFund;
    if (total <= 0) {
      throw new Error("At least one of CBU / Mortuary / Emergency must be > 0");
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: input.customerId },
      select: { firstName: true, middleName: true, lastName: true },
    });
    if (!customer) throw new Error("Customer not found");
    const contributedAt = input.contributedAt ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.contribution.create({
        data: {
          customerId: input.customerId,
          capitalBuildUp: input.capitalBuildUp as unknown as Prisma.Decimal,
          mortuaryFund: input.mortuaryFund as unknown as Prisma.Decimal,
          emergencyFund: input.emergencyFund as unknown as Prisma.Decimal,
          notes: input.notes,
          contributedAt,
          recordedById: input.recordedById,
        },
      });
      const entry = contributionEntry({
        contributionId: row.id,
        customerName: memberName(customer),
        capitalBuildUp: input.capitalBuildUp,
        mortuaryFund: input.mortuaryFund,
        emergencyFund: input.emergencyFund,
        contributedAt,
      });
      if (entry) {
        const posted = await this.accounting.postEntry(entry, {
          postedById: input.recordedById,
          tx,
        });
        return tx.contribution.update({
          where: { id: row.id },
          data: { journalEntryId: posted.id },
        });
      }
      return row;
    });
  }

  // ─── Savings ────────────────────────────────────────────────────

  listSavings(): Promise<SavingsTransaction[]> {
    return this.prisma.savingsTransaction.findMany({
      orderBy: { txnDate: "desc" },
      take: 500,
    });
  }

  async createSavings(input: SavingsCreateInput): Promise<SavingsTransaction> {
    if (input.amount <= 0) throw new Error("Amount must be > 0");
    const customer = await this.prisma.customer.findUnique({
      where: { id: input.customerId },
      select: { firstName: true, middleName: true, lastName: true },
    });
    if (!customer) throw new Error("Customer not found");
    const txnDate = input.txnDate ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.savingsTransaction.create({
        data: {
          customerId: input.customerId,
          kind: input.kind,
          amount: input.amount as unknown as Prisma.Decimal,
          notes: input.notes,
          txnDate,
          recordedById: input.recordedById,
        },
      });
      const entry = savingsEntry({
        txnId: row.id,
        customerName: memberName(customer),
        amount: input.amount,
        kind: input.kind,
        txnDate,
      });
      if (entry) {
        const posted = await this.accounting.postEntry(entry, {
          postedById: input.recordedById,
          tx,
        });
        return tx.savingsTransaction.update({
          where: { id: row.id },
          data: { journalEntryId: posted.id },
        });
      }
      return row;
    });
  }

  // ─── Funds (generic inflows + withdrawals) ──────────────────────

  listFundTxns(): Promise<FundTransaction[]> {
    return this.prisma.fundTransaction.findMany({
      orderBy: { txnDate: "desc" },
      take: 500,
    });
  }

  async createFundTxn(
    input: FundTransactionCreateInput,
  ): Promise<FundTransaction> {
    if (input.amount <= 0) throw new Error("Amount must be > 0");
    const txnDate = input.txnDate ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fundTransaction.create({
        data: {
          customerId: input.customerId,
          transactionRef: input.transactionRef,
          sourceOfFunds: input.sourceOfFunds,
          amount: input.amount as unknown as Prisma.Decimal,
          txnDate,
          authorId: input.authorId,
          notes: input.notes,
        },
      });
      const entry = fundTransactionEntry({
        txnId: row.id,
        sourceOfFunds: input.sourceOfFunds,
        amount: input.amount,
        memo: input.notes,
        txnDate,
      });
      if (entry) {
        const posted = await this.accounting.postEntry(entry, {
          postedById: input.authorId,
          tx,
        });
        return tx.fundTransaction.update({
          where: { id: row.id },
          data: { journalEntryId: posted.id },
        });
      }
      return row;
    });
  }

  listWithdrawals(): Promise<FundWithdrawal[]> {
    return this.prisma.fundWithdrawal.findMany({
      orderBy: { txnDate: "desc" },
      take: 500,
    });
  }

  async createWithdrawal(
    input: FundWithdrawalCreateInput,
  ): Promise<FundWithdrawal> {
    if (input.amount <= 0) throw new Error("Amount must be > 0");
    const txnDate = input.txnDate ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.fundWithdrawal.create({
        data: {
          customerId: input.customerId,
          sourceOfFunds: input.sourceOfFunds,
          amount: input.amount as unknown as Prisma.Decimal,
          notes: input.notes,
          txnDate,
          authorId: input.authorId,
        },
      });
      const entry = fundWithdrawalEntry({
        withdrawalId: row.id,
        sourceOfFunds: input.sourceOfFunds,
        amount: input.amount,
        memo: input.notes,
        txnDate,
      });
      if (entry) {
        const posted = await this.accounting.postEntry(entry, {
          postedById: input.authorId,
          tx,
        });
        return tx.fundWithdrawal.update({
          where: { id: row.id },
          data: { journalEntryId: posted.id },
        });
      }
      return row;
    });
  }

  // ─── Expenses ──────────────────────────────────────────────────

  listExpenses(): Promise<Expense[]> {
    return this.prisma.expense.findMany({
      orderBy: { txnDate: "desc" },
      take: 500,
    });
  }

  async createExpense(input: ExpenseCreateInput): Promise<Expense> {
    if (input.amount <= 0) throw new Error("Amount must be > 0");
    const txnDate = input.txnDate ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.expense.create({
        data: {
          type: input.type,
          amount: input.amount as unknown as Prisma.Decimal,
          sourceOfFunds: input.sourceOfFunds,
          txnDate,
          isRecurring: input.isRecurring ?? false,
          attachments: input.attachments ?? [],
          notes: input.notes,
          recordedById: input.recordedById,
        },
      });
      const entry = expenseEntry({
        expenseId: row.id,
        type: input.type,
        amount: input.amount,
        sourceOfFunds: input.sourceOfFunds,
        txnDate,
      });
      if (entry) {
        const posted = await this.accounting.postEntry(entry, {
          postedById: input.recordedById,
          tx,
        });
        return tx.expense.update({
          where: { id: row.id },
          data: { journalEntryId: posted.id },
        });
      }
      return row;
    });
  }

  // ─── Other income ──────────────────────────────────────────────

  listOtherIncome(): Promise<OtherIncome[]> {
    return this.prisma.otherIncome.findMany({
      orderBy: { txnDate: "desc" },
      take: 500,
    });
  }

  async createOtherIncome(input: OtherIncomeCreateInput): Promise<OtherIncome> {
    if (input.amount <= 0) throw new Error("Amount must be > 0");
    const txnDate = input.txnDate ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.otherIncome.create({
        data: {
          type: input.type,
          amount: input.amount as unknown as Prisma.Decimal,
          sourceTo: input.sourceTo,
          txnDate,
          attachments: input.attachments ?? [],
          notes: input.notes,
          recordedById: input.recordedById,
        },
      });
      const entry = otherIncomeEntry({
        incomeId: row.id,
        type: input.type,
        amount: input.amount,
        sourceTo: input.sourceTo,
        txnDate,
      });
      if (entry) {
        const posted = await this.accounting.postEntry(entry, {
          postedById: input.recordedById,
          tx,
        });
        return tx.otherIncome.update({
          where: { id: row.id },
          data: { journalEntryId: posted.id },
        });
      }
      return row;
    });
  }

  // ─── Member ledger ─────────────────────────────────────────────

  /**
   * Per-member rollup: CBU / Mortuary / Emergency lifetime totals,
   * savings net balance, and the most recent transactions for each
   * surface. Built for the right-side drawer so an accountant can
   * pull up a member's position without leaving the page they're on.
   */
  async memberLedger(customerId: string) {
    const [customer, contributions, savings] = await Promise.all([
      this.prisma.customer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          number: true,
          firstName: true,
          middleName: true,
          lastName: true,
          email: true,
          phone: true,
          governmentIdType: true,
          governmentIdNumber: true,
        },
      }),
      this.prisma.contribution.findMany({
        where: { customerId },
        orderBy: { contributedAt: "desc" },
        take: 20,
      }),
      this.prisma.savingsTransaction.findMany({
        where: { customerId },
        orderBy: { txnDate: "desc" },
        take: 20,
      }),
    ]);
    if (!customer) return null;

    // Roll up contributions across all rows (not just the top 20).
    const allContribs = await this.prisma.contribution.aggregate({
      where: { customerId },
      _sum: {
        capitalBuildUp: true,
        mortuaryFund: true,
        emergencyFund: true,
      },
      _count: { _all: true },
    });

    // Savings net: deposits − withdrawals across all rows.
    const allSavings = await this.prisma.savingsTransaction.groupBy({
      by: ["kind"],
      where: { customerId },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const deposits =
      allSavings.find((s) => s.kind === "DEPOSIT")?._sum.amount ?? 0;
    const withdrawals =
      allSavings.find((s) => s.kind === "WITHDRAWAL")?._sum.amount ?? 0;
    const depositCount =
      allSavings.find((s) => s.kind === "DEPOSIT")?._count._all ?? 0;
    const withdrawalCount =
      allSavings.find((s) => s.kind === "WITHDRAWAL")?._count._all ?? 0;

    return {
      customer,
      totals: {
        capitalBuildUp: Number(allContribs._sum.capitalBuildUp ?? 0),
        mortuaryFund: Number(allContribs._sum.mortuaryFund ?? 0),
        emergencyFund: Number(allContribs._sum.emergencyFund ?? 0),
        contributionsCount: allContribs._count._all,
        savingsNet: Number(deposits) - Number(withdrawals),
        savingsDeposits: Number(deposits),
        savingsWithdrawals: Number(withdrawals),
        depositCount,
        withdrawalCount,
      },
      recentContributions: contributions,
      recentSavings: savings,
    };
  }

  // ─── Big Brother (external capital) ────────────────────────────

  listBigBrother(): Promise<BigBrotherAccount[]> {
    return this.prisma.bigBrotherAccount.findMany({
      orderBy: { createdAt: "desc" },
    });
  }

  async createBigBrother(
    input: BigBrotherCreateInput,
  ): Promise<BigBrotherAccount> {
    if (input.capital <= 0) throw new Error("Capital must be > 0");
    if (input.periodTo <= input.periodFrom) {
      throw new Error("periodTo must be after periodFrom");
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.bigBrotherAccount.create({
        data: {
          name: input.name,
          account: input.account,
          capital: input.capital as unknown as Prisma.Decimal,
          periodFrom: input.periodFrom,
          periodTo: input.periodTo,
          notes: input.notes,
          recordedById: input.recordedById,
        },
      });
      const entry = bigBrotherEntry({
        accountId: row.id,
        name: input.name,
        capital: input.capital,
        receivedAt: input.periodFrom,
      });
      if (entry) {
        const posted = await this.accounting.postEntry(entry, {
          postedById: input.recordedById,
          tx,
        });
        return tx.bigBrotherAccount.update({
          where: { id: row.id },
          data: { journalEntryId: posted.id },
        });
      }
      return row;
    });
  }
}
