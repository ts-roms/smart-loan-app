/**
 * Cooperative module hooks — Contributions, Savings, Funds, Withdrawals,
 * Expenses, Other Income, Big Brother. Each entity gets a list query +
 * a create mutation. Reads + writes share the same query-key prefix so
 * a successful create invalidates the list.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client.js";

// ─── Shared types (kept light — the UI mostly displays raw rows) ──

export interface Contribution {
  id: string;
  customerId: string;
  capitalBuildUp: string | number;
  mortuaryFund: string | number;
  emergencyFund: string | number;
  notes: string | null;
  contributedAt: string;
  recordedById: string | null;
  journalEntryId: string | null;
}

export interface SavingsTransaction {
  id: string;
  customerId: string;
  kind: "DEPOSIT" | "WITHDRAWAL";
  amount: string | number;
  notes: string | null;
  txnDate: string;
  recordedById: string | null;
  journalEntryId: string | null;
}

export interface FundTransaction {
  id: string;
  customerId: string | null;
  transactionRef: string | null;
  sourceOfFunds: string;
  amount: string | number;
  txnDate: string;
  authorId: string | null;
  notes: string | null;
  journalEntryId: string | null;
}

export interface FundWithdrawal {
  id: string;
  customerId: string | null;
  sourceOfFunds: string;
  amount: string | number;
  notes: string | null;
  txnDate: string;
  authorId: string | null;
  journalEntryId: string | null;
}

export interface Expense {
  id: string;
  type: string;
  amount: string | number;
  sourceOfFunds: string;
  txnDate: string;
  isRecurring: boolean;
  attachments: string[];
  notes: string | null;
  recordedById: string | null;
  journalEntryId: string | null;
}

export interface OtherIncome {
  id: string;
  type: string;
  amount: string | number;
  sourceTo: string;
  txnDate: string;
  attachments: string[];
  notes: string | null;
  recordedById: string | null;
  journalEntryId: string | null;
}

export interface BigBrotherAccount {
  id: string;
  name: string;
  account: string;
  capital: string | number;
  periodFrom: string;
  periodTo: string;
  notes: string | null;
  active: boolean;
  createdAt: string;
  recordedById: string | null;
  journalEntryId: string | null;
}

export const coopKeys = {
  contributions: ["coop", "contributions"] as const,
  savings: ["coop", "savings"] as const,
  funds: ["coop", "funds"] as const,
  withdrawals: ["coop", "withdrawals"] as const,
  expenses: ["coop", "expenses"] as const,
  otherIncome: ["coop", "other-income"] as const,
  bigBrother: ["coop", "big-brother"] as const,
};

// ─── Contributions ───────────────────────────────────────────────

export function useContributions() {
  return useQuery({
    queryKey: coopKeys.contributions,
    queryFn: () =>
      getApiClient().get<Contribution[]>("/cooperative/contributions"),
  });
}

export function useCreateContribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId: string;
      capitalBuildUp: number;
      mortuaryFund: number;
      emergencyFund: number;
      notes?: string;
      contributedAt?: string;
    }) =>
      getApiClient().post<Contribution>("/cooperative/contributions", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: coopKeys.contributions }),
  });
}

// ─── Savings ─────────────────────────────────────────────────────

export function useSavingsTxns() {
  return useQuery({
    queryKey: coopKeys.savings,
    queryFn: () =>
      getApiClient().get<SavingsTransaction[]>("/cooperative/savings"),
  });
}

export function useCreateSavings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId: string;
      amount: number;
      kind: "DEPOSIT" | "WITHDRAWAL";
      notes?: string;
      txnDate?: string;
    }) =>
      getApiClient().post<SavingsTransaction>("/cooperative/savings", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: coopKeys.savings }),
  });
}

// ─── Funds + Withdrawals ────────────────────────────────────────

export function useFundTxns() {
  return useQuery({
    queryKey: coopKeys.funds,
    queryFn: () => getApiClient().get<FundTransaction[]>("/cooperative/funds"),
  });
}

export function useCreateFundTxn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId?: string;
      transactionRef?: string;
      sourceOfFunds: string;
      amount: number;
      txnDate?: string;
      notes?: string;
    }) => getApiClient().post<FundTransaction>("/cooperative/funds", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: coopKeys.funds }),
  });
}

export function useFundWithdrawals() {
  return useQuery({
    queryKey: coopKeys.withdrawals,
    queryFn: () =>
      getApiClient().get<FundWithdrawal[]>("/cooperative/withdrawals"),
  });
}

export function useCreateFundWithdrawal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId?: string;
      sourceOfFunds: string;
      amount: number;
      notes?: string;
      txnDate?: string;
    }) =>
      getApiClient().post<FundWithdrawal>("/cooperative/withdrawals", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: coopKeys.withdrawals }),
  });
}

// ─── Expenses ────────────────────────────────────────────────────

export function useExpenses() {
  return useQuery({
    queryKey: coopKeys.expenses,
    queryFn: () => getApiClient().get<Expense[]>("/cooperative/expenses"),
  });
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      type: string;
      amount: number;
      sourceOfFunds: string;
      txnDate?: string;
      isRecurring?: boolean;
      attachments?: string[];
      notes?: string;
    }) => getApiClient().post<Expense>("/cooperative/expenses", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: coopKeys.expenses }),
  });
}

// ─── Other Income ────────────────────────────────────────────────

export function useOtherIncome() {
  return useQuery({
    queryKey: coopKeys.otherIncome,
    queryFn: () =>
      getApiClient().get<OtherIncome[]>("/cooperative/other-income"),
  });
}

export function useCreateOtherIncome() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      type: string;
      amount: number;
      sourceTo: string;
      txnDate?: string;
      attachments?: string[];
      notes?: string;
    }) => getApiClient().post<OtherIncome>("/cooperative/other-income", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: coopKeys.otherIncome }),
  });
}

// ─── Big Brother ─────────────────────────────────────────────────

export function useBigBrother() {
  return useQuery({
    queryKey: coopKeys.bigBrother,
    queryFn: () =>
      getApiClient().get<BigBrotherAccount[]>("/cooperative/big-brother"),
  });
}

export interface MemberLedger {
  customer: {
    id: string;
    /** Human-readable customer number ("CUST-..."). */
    number: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
    email: string | null;
    phone: string;
    governmentIdType: string;
    governmentIdNumber: string;
  };
  totals: {
    capitalBuildUp: number;
    mortuaryFund: number;
    emergencyFund: number;
    contributionsCount: number;
    savingsNet: number;
    savingsDeposits: number;
    savingsWithdrawals: number;
    depositCount: number;
    withdrawalCount: number;
  };
  recentContributions: Contribution[];
  recentSavings: SavingsTransaction[];
}

export function useMemberLedger(customerId: string | null) {
  return useQuery({
    queryKey: ["coop", "member-ledger", customerId ?? ""],
    queryFn: () =>
      getApiClient().get<MemberLedger>(
        `/cooperative/members/${customerId}/ledger`,
      ),
    enabled: Boolean(customerId),
  });
}

export function useCreateBigBrother() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      account: string;
      capital: number;
      periodFrom: string;
      periodTo: string;
      notes?: string;
    }) =>
      getApiClient().post<BigBrotherAccount>("/cooperative/big-brother", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: coopKeys.bigBrother }),
  });
}
