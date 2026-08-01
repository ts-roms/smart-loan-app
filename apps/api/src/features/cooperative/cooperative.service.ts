import { type CooperativeRepository } from "@loan/db";

import type {
  BigBrotherInput,
  ContributionInput,
  ExpenseInput,
  FundTxnInput,
  OtherIncomeInput,
  SavingsInput,
  WithdrawalInput,
} from "./schemas";

/**
 * Cooperative orchestration. Seven entity types, each with `list` and
 * `create`. Every create method:
 *   1. Coerces ISO-string date fields into `Date` (the repo signature
 *      requires it and Prisma rejects raw strings on DateTime columns).
 *   2. Wraps the repo write in try/catch so the route never throws.
 *
 * No explicit audit-log writes here: every cooperative create auto-
 * posts a journal entry inside the repo, and journals ARE the audit
 * trail for fund movement. Adding an audit row on top would just be
 * a duplicate.
 */

type CreateResult<T> =
  { ok: true; row: T } | { ok: false; kind: "RepoError"; message: string };

export type ContributionResult = CreateResult<
  Awaited<ReturnType<CooperativeRepository["createContribution"]>>
>;
export type SavingsResult = CreateResult<
  Awaited<ReturnType<CooperativeRepository["createSavings"]>>
>;
export type FundTxnResult = CreateResult<
  Awaited<ReturnType<CooperativeRepository["createFundTxn"]>>
>;
export type WithdrawalResult = CreateResult<
  Awaited<ReturnType<CooperativeRepository["createWithdrawal"]>>
>;
export type ExpenseResult = CreateResult<
  Awaited<ReturnType<CooperativeRepository["createExpense"]>>
>;
export type OtherIncomeResult = CreateResult<
  Awaited<ReturnType<CooperativeRepository["createOtherIncome"]>>
>;
export type BigBrotherResult = CreateResult<
  Awaited<ReturnType<CooperativeRepository["createBigBrother"]>>
>;

export class CooperativeService {
  constructor(private readonly repo: CooperativeRepository) {}

  // ─── reads ────────────────────────────────────────────────────────

  listContributions = () => this.repo.listContributions();
  listSavings = () => this.repo.listSavings();
  listFundTxns = () => this.repo.listFundTxns();
  listWithdrawals = () => this.repo.listWithdrawals();
  listExpenses = () => this.repo.listExpenses();
  listOtherIncome = () => this.repo.listOtherIncome();
  listBigBrother = () => this.repo.listBigBrother();

  memberLedger = (customerId: string) => this.repo.memberLedger(customerId);

  // ─── writes ───────────────────────────────────────────────────────

  async createContribution(args: {
    input: ContributionInput;
    actorId: string;
  }): Promise<ContributionResult> {
    return this.guard(() =>
      this.repo.createContribution({
        ...args.input,
        contributedAt: parseDate(args.input.contributedAt),
        recordedById: args.actorId,
      }),
    );
  }

  async createSavings(args: {
    input: SavingsInput;
    actorId: string;
  }): Promise<SavingsResult> {
    return this.guard(() =>
      this.repo.createSavings({
        ...args.input,
        txnDate: parseDate(args.input.txnDate),
        recordedById: args.actorId,
      }),
    );
  }

  async createFundTxn(args: {
    input: FundTxnInput;
    actorId: string;
  }): Promise<FundTxnResult> {
    return this.guard(() =>
      this.repo.createFundTxn({
        ...args.input,
        txnDate: parseDate(args.input.txnDate),
        authorId: args.actorId,
      }),
    );
  }

  async createWithdrawal(args: {
    input: WithdrawalInput;
    actorId: string;
  }): Promise<WithdrawalResult> {
    return this.guard(() =>
      this.repo.createWithdrawal({
        ...args.input,
        txnDate: parseDate(args.input.txnDate),
        authorId: args.actorId,
      }),
    );
  }

  async createExpense(args: {
    input: ExpenseInput;
    actorId: string;
  }): Promise<ExpenseResult> {
    return this.guard(() =>
      this.repo.createExpense({
        ...args.input,
        txnDate: parseDate(args.input.txnDate),
        recordedById: args.actorId,
      }),
    );
  }

  async createOtherIncome(args: {
    input: OtherIncomeInput;
    actorId: string;
  }): Promise<OtherIncomeResult> {
    return this.guard(() =>
      this.repo.createOtherIncome({
        ...args.input,
        txnDate: parseDate(args.input.txnDate),
        recordedById: args.actorId,
      }),
    );
  }

  async createBigBrother(args: {
    input: BigBrotherInput;
    actorId: string;
  }): Promise<BigBrotherResult> {
    return this.guard(() =>
      this.repo.createBigBrother({
        ...args.input,
        periodFrom: new Date(args.input.periodFrom),
        periodTo: new Date(args.input.periodTo),
        recordedById: args.actorId,
      }),
    );
  }

  // ─── internals ────────────────────────────────────────────────────

  /**
   * Shared try/catch wrapper. The cooperative repo throws on chart-of-
   * accounts misconfiguration ("no contra account for source FX") and
   * referential errors (customer not found). All of those become 400s
   * to the caller.
   */
  private async guard<T>(run: () => Promise<T>): Promise<CreateResult<T>> {
    try {
      return { ok: true, row: await run() };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }
}

function parseDate(s: string | undefined): Date | undefined {
  return s ? new Date(s) : undefined;
}
