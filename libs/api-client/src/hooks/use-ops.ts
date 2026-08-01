/**
 * Hooks for operational features: jobs, notifications, AML screening,
 * portfolio analytics. Kept in one file because each is small.
 */
import type {
  AmlScreening,
  AmlWatchlistEntry,
  JobRun,
  Notification,
  NotificationChannel,
  OriginationMonth,
  PortfolioSummary,
  ScheduledJob,
  VintageCohort,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

// ─── Jobs ──────────────────────────────────────────────────────────

export const jobKeys = {
  all: ["jobs"] as const,
  runs: (name: string) => ["jobs", "runs", name] as const,
};

export function useJobs() {
  return useQuery({
    queryKey: jobKeys.all,
    queryFn: () => getApiClient().get<ScheduledJob[]>("/jobs"),
  });
}

export function useJobRuns(name: string | null) {
  return useQuery({
    queryKey: jobKeys.runs(name ?? ""),
    queryFn: () => getApiClient().get<JobRun[]>(`/jobs/${name}/runs`),
    enabled: Boolean(name),
  });
}

export function useRunJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      getApiClient().post<JobRun>(`/jobs/${name}/run`, {}),
    onSuccess: (_d, name) => {
      void qc.invalidateQueries({ queryKey: jobKeys.all });
      void qc.invalidateQueries({ queryKey: jobKeys.runs(name) });
    },
  });
}

export function useSetJobEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; enabled: boolean }) =>
      getApiClient().request<ScheduledJob>(`/jobs/${input.name}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: input.enabled }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: jobKeys.all }),
  });
}

export function useUpdateJobCron() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; cron: string }) =>
      getApiClient().request<ScheduledJob>(`/jobs/${input.name}/cron`, {
        method: "PATCH",
        body: JSON.stringify({ cron: input.cron }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: jobKeys.all }),
  });
}

// ─── Notifications ──────────────────────────────────────────────────

export function useNotifications(params?: {
  customerId?: string;
  status?: string;
}) {
  const qs = new URLSearchParams();
  if (params?.customerId) qs.set("customerId", params.customerId);
  if (params?.status) qs.set("status", params.status);
  const s = qs.toString();
  return useQuery({
    queryKey: ["notifications", params ?? {}],
    queryFn: () =>
      getApiClient().get<Notification[]>(`/notifications${s ? `?${s}` : ""}`),
  });
}

export function useSendTestNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      channel: NotificationChannel;
      recipient: string;
      note?: string;
    }) => getApiClient().post<Notification>("/notifications/test", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

// ─── Screening ──────────────────────────────────────────────────────

export function useCustomerScreenings(customerId: string | null) {
  return useQuery({
    queryKey: ["screening", "customer", customerId ?? ""],
    queryFn: () =>
      getApiClient().get<AmlScreening[]>(`/screening/customers/${customerId}`),
    enabled: Boolean(customerId),
  });
}

export function useLatestScreening(customerId: string | null) {
  return useQuery({
    queryKey: ["screening", "customer", customerId ?? "", "latest"],
    queryFn: () =>
      getApiClient().get<AmlScreening | null>(
        `/screening/customers/${customerId}/latest`,
      ),
    enabled: Boolean(customerId),
  });
}

export function useRunScreening() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (customerId: string) =>
      getApiClient().post<AmlScreening>(
        `/screening/customers/${customerId}/run`,
        {},
      ),
    onSuccess: (_d, customerId) => {
      void qc.invalidateQueries({
        queryKey: ["screening", "customer", customerId],
      });
    },
  });
}

export function useOverrideScreening() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { customerId: string; note: string }) =>
      getApiClient().post<AmlScreening>(
        `/screening/customers/${input.customerId}/override`,
        { note: input.note },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({
        queryKey: ["screening", "customer", vars.customerId],
      }),
  });
}

export function useWatchlist() {
  return useQuery({
    queryKey: ["screening", "watchlist"],
    queryFn: () =>
      getApiClient().get<AmlWatchlistEntry[]>("/screening/watchlist"),
  });
}

export function useAddWatchlistEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      list: string;
      fullName: string;
      aliases?: string[];
      reason?: string;
    }) => getApiClient().post<AmlWatchlistEntry>("/screening/watchlist", input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["screening", "watchlist"] }),
  });
}

export function useDeleteWatchlistEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getApiClient().request<AmlWatchlistEntry>(`/screening/watchlist/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["screening", "watchlist"] }),
  });
}

// ─── Analytics ──────────────────────────────────────────────────────

export function usePortfolioSummary(asOf?: string) {
  const qs = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return useQuery({
    queryKey: ["analytics", "portfolio-summary", asOf ?? ""],
    queryFn: () =>
      getApiClient().get<PortfolioSummary>(
        `/accounting/reports/portfolio-summary${qs}`,
      ),
  });
}

export function useOriginations() {
  return useQuery({
    queryKey: ["analytics", "originations"],
    queryFn: () =>
      getApiClient().get<OriginationMonth[]>(
        "/accounting/reports/originations",
      ),
  });
}

export function useVintageCohorts() {
  return useQuery({
    queryKey: ["analytics", "vintage"],
    queryFn: () =>
      getApiClient().get<VintageCohort[]>("/accounting/reports/vintage"),
  });
}

// ─── ECL (IFRS 9 / PFRS 9) ─────────────────────────────────────────

export interface EclRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  asOf: string;
  totalEad: string | number;
  totalEcl: string | number;
  stage1Count: number;
  stage2Count: number;
  stage3Count: number;
  stage1Ecl: string | number;
  stage2Ecl: string | number;
  stage3Ecl: string | number;
  journalEntryId: string | null;
  computedById: string | null;
  notes: string | null;
}

export interface EclRunResult {
  id: string;
  totalEad: number;
  totalEcl: number;
  byStage: Record<
    "STAGE_1" | "STAGE_2" | "STAGE_3",
    { count: number; ecl: number }
  >;
  perLoan: Array<{
    loanId: string;
    number: string;
    dpd: number;
    stage: "STAGE_1" | "STAGE_2" | "STAGE_3";
    ead: number;
    ecl: number;
  }>;
  delta: number;
  journalEntryId: string | null;
}

export const eclKeys = {
  runs: ["ecl", "runs"] as const,
};

export function useEclRuns() {
  return useQuery({
    queryKey: eclKeys.runs,
    queryFn: () => getApiClient().get<EclRun[]>("/ecl/runs"),
  });
}

export function useRunEcl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input?: {
      periodStart?: string;
      periodEnd?: string;
      notes?: string;
    }) => getApiClient().post<EclRunResult>("/ecl/runs", input ?? {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: eclKeys.runs }),
  });
}

// ─── Bank reconciliation ──────────────────────────────────────────

export interface BankStatement {
  id: string;
  label: string;
  bankAccount: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: string | number;
  closingBalance: string | number;
  importedById: string | null;
  importedAt: string;
  status: "IMPORTED" | "RECONCILED" | "ARCHIVED";
}

export interface BankStatementLine {
  id: string;
  statementId: string;
  txnDate: string;
  description: string;
  amount: string | number;
  reference: string | null;
  runningBalance: string | number | null;
  matchedType: string | null;
  matchedRefId: string | null;
  matchedAt: string | null;
  matchedById: string | null;
  matchNote: string | null;
}

export interface BankStatementDetail extends BankStatement {
  lines: BankStatementLine[];
}

export interface BankStatementSummary {
  totalLines: number;
  matched: number;
  unmatched: number;
  matchedAmount: number;
  unmatchedAmount: number;
}

export interface BankStatementCreateInput {
  label: string;
  bankAccount: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  lines: Array<{
    txnDate: string;
    description: string;
    amount: number;
    reference?: string;
    runningBalance?: number;
  }>;
}

export const reconciliationKeys = {
  statements: ["reconciliation", "statements"] as const,
  statement: (id: string) => ["reconciliation", "statements", id] as const,
  summary: (id: string) =>
    ["reconciliation", "statements", id, "summary"] as const,
};

export function useBankStatements() {
  return useQuery({
    queryKey: reconciliationKeys.statements,
    queryFn: () =>
      getApiClient().get<BankStatement[]>("/reconciliation/statements"),
  });
}

export function useBankStatement(id: string | null) {
  return useQuery({
    queryKey: reconciliationKeys.statement(id ?? ""),
    queryFn: () =>
      getApiClient().get<BankStatementDetail>(
        `/reconciliation/statements/${id}`,
      ),
    enabled: Boolean(id),
  });
}

export function useBankStatementSummary(id: string | null) {
  return useQuery({
    queryKey: reconciliationKeys.summary(id ?? ""),
    queryFn: () =>
      getApiClient().get<BankStatementSummary>(
        `/reconciliation/statements/${id}/summary`,
      ),
    enabled: Boolean(id),
  });
}

export function useImportBankStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BankStatementCreateInput) =>
      getApiClient().post<BankStatement>("/reconciliation/statements", input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: reconciliationKeys.statements }),
  });
}

export function useAutoMatchStatement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getApiClient().post<{
        matchedLines: number;
        matchedAmount: number;
      }>(`/reconciliation/statements/${id}/auto-match`, {}),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: reconciliationKeys.statement(id) });
      void qc.invalidateQueries({ queryKey: reconciliationKeys.summary(id) });
    },
  });
}

export function useMatchLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      lineId: string;
      statementId: string;
      type: string;
      refId?: string;
      note?: string;
    }) =>
      getApiClient().post<BankStatementLine>(
        `/reconciliation/lines/${input.lineId}/match`,
        {
          type: input.type,
          refId: input.refId,
          note: input.note,
        },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({
        queryKey: reconciliationKeys.statement(vars.statementId),
      });
      void qc.invalidateQueries({
        queryKey: reconciliationKeys.summary(vars.statementId),
      });
    },
  });
}

export interface BankLineCandidate {
  type: "LoanPayment" | "LoanDisbursement";
  refId: string;
  score: number;
  label: string;
  detail: string;
}

export function useBankLineCandidates(lineId: string | null) {
  return useQuery({
    queryKey: ["reconciliation", "candidates", lineId ?? ""],
    queryFn: () =>
      getApiClient().get<BankLineCandidate[]>(
        `/reconciliation/lines/${lineId}/candidates`,
      ),
    enabled: Boolean(lineId),
    staleTime: 30_000,
  });
}

export function useUnmatchLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { lineId: string; statementId: string }) =>
      getApiClient().post<BankStatementLine>(
        `/reconciliation/lines/${input.lineId}/unmatch`,
        {},
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({
        queryKey: reconciliationKeys.statement(vars.statementId),
      });
      void qc.invalidateQueries({
        queryKey: reconciliationKeys.summary(vars.statementId),
      });
    },
  });
}

// ─── In-app messaging (officer ↔ borrower) ─────────────────────────

export interface LoanMessage {
  id: string;
  loanId: string;
  authorId: string;
  authorRole: "OFFICER" | "BORROWER";
  body: string;
  readAt: string | null;
  createdAt: string;
}

export const loanMessageKeys = {
  thread: (loanId: string) => ["loan-messages", loanId] as const,
};

export function useLoanMessages(loanId: string | null) {
  return useQuery({
    queryKey: loanMessageKeys.thread(loanId ?? ""),
    queryFn: () =>
      getApiClient().get<LoanMessage[]>(`/loans/${loanId}/messages`),
    enabled: Boolean(loanId),
    refetchInterval: 15_000,
  });
}

export function useSendLoanMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; body: string }) =>
      getApiClient().post<LoanMessage>(`/loans/${input.loanId}/messages`, {
        body: input.body,
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: loanMessageKeys.thread(vars.loanId) }),
  });
}

export function useMarkLoanMessageRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; messageId: string }) =>
      getApiClient().post<LoanMessage>(
        `/loans/${input.loanId}/messages/${input.messageId}/read`,
        {},
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: loanMessageKeys.thread(vars.loanId) }),
  });
}
