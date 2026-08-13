import type {
  AccountingPeriod,
  AccrualJobResult,
  Account,
  AgingReport,
  BalanceSheetReport,
  IncomeStatementReport,
  JournalEntry,
  JournalEntryCreateInput,
  LedgerLine,
  ProductProfitabilityReport,
  RollRateReport,
  TrialBalanceReport,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const accountingKeys = {
  accounts: ["accounting", "accounts"] as const,
  entries: (params?: { from?: string; to?: string; source?: string }) =>
    ["accounting", "journal", params ?? {}] as const,
  entry: (id: string) => ["accounting", "journal", "detail", id] as const,
  ledger: (accountId: string, params?: { from?: string; to?: string }) =>
    ["accounting", "ledger", accountId, params ?? {}] as const,
  trialBalance: (asOf?: string) =>
    ["accounting", "reports", "trial-balance", asOf ?? ""] as const,
  incomeStatement: (from?: string, to?: string) =>
    [
      "accounting",
      "reports",
      "income-statement",
      from ?? "",
      to ?? "",
    ] as const,
  balanceSheet: (asOf?: string) =>
    ["accounting", "reports", "balance-sheet", asOf ?? ""] as const,
  loanPortfolio: (asOf?: string) =>
    ["accounting", "reports", "loan-portfolio", asOf ?? ""] as const,
  rollRate: (from?: string, to?: string) =>
    ["reports", "roll-rate", from ?? "", to ?? ""] as const,
  productProfitability: (from?: string, to?: string) =>
    ["reports", "product-profitability", from ?? "", to ?? ""] as const,
};

export function useAccounts() {
  return useQuery({
    queryKey: accountingKeys.accounts,
    queryFn: () => getApiClient().get<Account[]>("/accounting/accounts"),
  });
}

export function useSeedChart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().post<{ created: number; existing: number }>(
        "/accounting/accounts/seed",
        {},
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: accountingKeys.accounts }),
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      code: string;
      name: string;
      type: Account["type"];
      normalBalance: Account["normalBalance"];
      description?: string;
    }) => getApiClient().post<Account>("/accounting/accounts", input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: accountingKeys.accounts }),
  });
}

export function useJournalEntries(params?: {
  from?: string;
  to?: string;
  source?: string;
}) {
  const query = new URLSearchParams();
  if (params?.from) query.set("from", params.from);
  if (params?.to) query.set("to", params.to);
  if (params?.source) query.set("source", params.source);
  const qs = query.toString();
  return useQuery({
    queryKey: accountingKeys.entries(params),
    queryFn: () =>
      getApiClient().get<JournalEntry[]>(
        `/accounting/journal${qs ? `?${qs}` : ""}`,
      ),
  });
}

export function useJournalEntry(id: string | null) {
  return useQuery({
    queryKey: accountingKeys.entry(id ?? ""),
    queryFn: () =>
      getApiClient().get<JournalEntry>(`/accounting/journal/${id}`),
    enabled: Boolean(id),
  });
}

export function usePostJournalEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: JournalEntryCreateInput) =>
      getApiClient().post<JournalEntry>("/accounting/journal", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["accounting"] });
    },
  });
}

export function useLedger(
  accountId: string | null,
  params?: { from?: string; to?: string },
) {
  const query = new URLSearchParams();
  if (params?.from) query.set("from", params.from);
  if (params?.to) query.set("to", params.to);
  const qs = query.toString();
  return useQuery({
    queryKey: accountingKeys.ledger(accountId ?? "", params),
    queryFn: () =>
      getApiClient().get<LedgerLine[]>(
        `/accounting/ledger/${accountId}${qs ? `?${qs}` : ""}`,
      ),
    enabled: Boolean(accountId),
  });
}

export function useTrialBalance(asOf?: string) {
  const qs = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return useQuery({
    queryKey: accountingKeys.trialBalance(asOf),
    queryFn: () =>
      getApiClient().get<TrialBalanceReport>(
        `/accounting/reports/trial-balance${qs}`,
      ),
  });
}

export function useIncomeStatement(from?: string, to?: string) {
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const qs = query.toString();
  return useQuery({
    queryKey: accountingKeys.incomeStatement(from, to),
    queryFn: () =>
      getApiClient().get<IncomeStatementReport>(
        `/accounting/reports/income-statement${qs ? `?${qs}` : ""}`,
      ),
  });
}

export function useBalanceSheet(asOf?: string) {
  const qs = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return useQuery({
    queryKey: accountingKeys.balanceSheet(asOf),
    queryFn: () =>
      getApiClient().get<BalanceSheetReport>(
        `/accounting/reports/balance-sheet${qs}`,
      ),
  });
}

export function useLoanPortfolio(
  asOf?: string,
  opts: { enabled?: boolean } = {},
) {
  const qs = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return useQuery({
    queryKey: accountingKeys.loanPortfolio(asOf),
    queryFn: () =>
      getApiClient().get<AgingReport>(
        `/accounting/reports/loan-portfolio${qs}`,
      ),
    // See QueryToggle in use-ops: suppressed for callers without
    // accounting.read rather than firing and taking a 403.
    enabled: opts.enabled ?? true,
  });
}

/**
 * Roll-rate matrix (§30) — `GET /reports/roll-rate`. Note the endpoint
 * lives in the reports feature (permission `reports.read`), not under
 * /accounting; the hook sits here because the page that renders it is
 * the aging report's.
 */
export function useRollRate(
  from?: string,
  to?: string,
  opts: { enabled?: boolean } = {},
) {
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const qs = query.toString();
  return useQuery({
    queryKey: accountingKeys.rollRate(from, to),
    queryFn: () =>
      getApiClient().get<RollRateReport>(
        `/reports/roll-rate${qs ? `?${qs}` : ""}`,
      ),
    enabled: opts.enabled ?? true,
  });
}

/**
 * Product profitability (§54) — `GET /reports/product-profitability`.
 * Same placement rule as `useRollRate`: the endpoint lives in the
 * reports feature (permission `reports.read`); the hook sits here with
 * the other ledger-derived report readers.
 */
export function useProductProfitability(
  from?: string,
  to?: string,
  opts: { enabled?: boolean } = {},
) {
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const qs = query.toString();
  return useQuery({
    queryKey: accountingKeys.productProfitability(from, to),
    queryFn: () =>
      getApiClient().get<ProductProfitabilityReport>(
        `/reports/product-profitability${qs ? `?${qs}` : ""}`,
      ),
    enabled: opts.enabled ?? true,
  });
}

// ─── Periods + accrual ────────────────────────────────────────────────

export const periodKeys = {
  all: ["accounting", "periods"] as const,
};

export function usePeriods() {
  return useQuery({
    queryKey: periodKeys.all,
    queryFn: () =>
      getApiClient().get<AccountingPeriod[]>("/accounting/periods"),
  });
}

export function useClosePeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { year: number; month: number }) =>
      getApiClient().post<AccountingPeriod>(
        `/accounting/periods/${p.year}/${p.month}/close`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: periodKeys.all });
      void qc.invalidateQueries({ queryKey: ["accounting"] });
    },
  });
}

export function useReopenPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { year: number; month: number }) =>
      getApiClient().post<AccountingPeriod>(
        `/accounting/periods/${p.year}/${p.month}/reopen`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: periodKeys.all });
      void qc.invalidateQueries({ queryKey: ["accounting"] });
    },
  });
}

export function useAccrueInterest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { year?: number; month?: number } = {}) =>
      getApiClient().post<AccrualJobResult>(
        "/accounting/jobs/accrue-interest",
        p,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounting"] }),
  });
}

// ─── Reversals ────────────────────────────────────────────────────────

export interface ReverseEntryResult {
  original: string;
  reversal: JournalEntry;
  alreadyReversed: boolean;
}

export interface BulkReverseRowResult {
  entryId: string;
  ok: boolean;
  reversalId?: string;
  error?: string;
}

export interface BulkReverseResponse {
  results: BulkReverseRowResult[];
  succeeded: number;
  failed: number;
}

export function useReverseEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; memo?: string }) =>
      getApiClient().post<ReverseEntryResult>(
        `/accounting/journal/${input.id}/reverse`,
        { memo: input.memo },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounting"] }),
  });
}

export function useReverseEntriesBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { entryIds: string[]; memo?: string }) =>
      getApiClient().post<BulkReverseResponse>(
        "/accounting/journal/reverse-bulk",
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounting"] }),
  });
}
