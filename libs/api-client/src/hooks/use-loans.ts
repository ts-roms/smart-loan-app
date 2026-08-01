import type {
  AmortizationRow,
  KycValidationResult,
  LoanApplication,
  LoanApplyInput,
  LoanDraft,
  LoanDraftCreateInput,
  LoanDraftUpdateInput,
  LoanDryRunInput,
  LoanDryRunResult,
  LoanPayment,
  LoanPenaltyTotals,
  PenaltyWaiver,
  SelfieMatchInput,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const loanKeys = {
  all: ["loans"] as const,
  detail: (id: string) => [...loanKeys.all, "detail", id] as const,
  kycStatus: (id: string) => [...loanKeys.all, "kyc-status", id] as const,
  penalties: (id: string) => [...loanKeys.all, "penalties", id] as const,
  penaltyWaivers: (id: string) =>
    [...loanKeys.all, "penalty-waivers", id] as const,
  drafts: () => [...loanKeys.all, "drafts"] as const,
  draft: (id: string) => [...loanKeys.all, "drafts", id] as const,
};

export interface LoanQuote {
  monthlyPayment: number;
  totalPaid: number;
  totalInterest: number;
  schedule: AmortizationRow[];
  fees: {
    processing: number;
    documentary: number;
    total: number;
    netDisbursement: number;
  };
  method: "DECLINING" | "FLAT";
  frequency: "MONTHLY" | "BIWEEKLY" | "WEEKLY";
  installments: number;
}

export function useLoans() {
  return useQuery({
    queryKey: loanKeys.all,
    queryFn: () => getApiClient().get<LoanApplication[]>("/loans"),
  });
}

export function useLoan(id: string | null) {
  return useQuery({
    queryKey: loanKeys.detail(id ?? ""),
    queryFn: () => getApiClient().get<LoanApplication>(`/loans/${id}`),
    enabled: Boolean(id),
  });
}

/** Per-loan KYC posture: base required docs + this product's extras. */
export function useLoanKycStatus(id: string | null) {
  return useQuery({
    queryKey: loanKeys.kycStatus(id ?? ""),
    queryFn: () =>
      getApiClient().get<KycValidationResult>(`/loans/${id}/kyc-status`),
    enabled: Boolean(id),
  });
}

export function useQuote() {
  return useMutation({
    mutationFn: (input: {
      principal: number;
      termMonths: number;
      annualInterestRate: number;
      productCode?: string;
    }) => getApiClient().post<LoanQuote>("/loans/quote", input),
  });
}

export function useApplyLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoanApplyInput) =>
      getApiClient().post<LoanApplication>("/loans/apply", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: loanKeys.all }),
  });
}

/**
 * Pre-decisioning preview — runs the rules engine against the in-flight
 * form values without creating a loan. Used by the smart new-loan dialog
 * to show the officer the verdict + reasons before they press Submit.
 * Called on a debounced effect so it doesn't fire on every keystroke.
 */
export function useDryRunLoan() {
  return useMutation({
    mutationFn: (input: LoanDryRunInput) =>
      getApiClient().post<LoanDryRunResult>("/loans/dry-run", input),
  });
}

/**
 * ─── Loan drafts (wizard state persistence) ───────────────────────
 * Each draft is a snapshot of the new-loan wizard for one officer.
 * Drafts are author-scoped server-side; no need to pass an authorId.
 */

/** List the current user's drafts, newest first. */
export function useLoanDrafts() {
  return useQuery({
    queryKey: loanKeys.drafts(),
    queryFn: () => getApiClient().get<LoanDraft[]>("/loans/drafts"),
    staleTime: 10_000,
  });
}

/** Single draft by id. Returns null on 404 (caller should redirect). */
export function useLoanDraft(id: string | null) {
  return useQuery({
    queryKey: loanKeys.draft(id ?? ""),
    queryFn: () => getApiClient().get<LoanDraft>(`/loans/drafts/${id}`),
    enabled: Boolean(id),
    retry: false, // 404 isn't worth retrying
  });
}

export function useCreateLoanDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoanDraftCreateInput) =>
      getApiClient().post<LoanDraft>("/loans/drafts", input),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: loanKeys.drafts() });
      qc.setQueryData(loanKeys.draft(created.id), created);
    },
  });
}

export function useUpdateLoanDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: LoanDraftUpdateInput }) =>
      getApiClient().request<LoanDraft>(`/loans/drafts/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input.patch),
      }),
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: loanKeys.drafts() });
      qc.setQueryData(loanKeys.draft(updated.id), updated);
    },
  });
}

export function useDeleteLoanDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getApiClient().request<void>(`/loans/drafts/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: loanKeys.drafts() });
      qc.removeQueries({ queryKey: loanKeys.draft(id) });
    },
  });
}

/**
 * Persist a face-match score (selfie ↔ ID similarity) computed
 * client-side via face-api.js. Invalidates the loan detail query on
 * success so the new score renders immediately.
 */
export function useRecordSelfieMatch(loanId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SelfieMatchInput) =>
      getApiClient().post<LoanApplication>(
        `/loans/${loanId}/selfie-match`,
        input,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: loanKeys.detail(loanId) });
    },
  });
}

export function useDecideLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      status: "APPROVED" | "REJECTED";
      reason?: string;
      overrideKyc?: boolean;
    }) =>
      getApiClient().post<LoanApplication>(`/loans/${input.id}/decide`, {
        status: input.status,
        reason: input.reason,
        overrideKyc: input.overrideKyc,
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: loanKeys.all });
      void qc.invalidateQueries({ queryKey: loanKeys.detail(vars.id) });
      void qc.invalidateQueries({ queryKey: loanKeys.kycStatus(vars.id) });
    },
  });
}

export function useDisburseLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getApiClient().post<LoanApplication>(`/loans/${id}/disburse`, {}),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: loanKeys.all });
      void qc.invalidateQueries({ queryKey: loanKeys.detail(id) });
    },
  });
}

export interface CloseEarlyResult {
  loan: LoanApplication;
  payment: LoanPayment;
  remainingPrincipal: number;
  fee: number;
  totalSettled: number;
}

export function useCloseEarlyLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      settlementAmount: number;
      reference?: string;
    }) =>
      getApiClient().post<CloseEarlyResult>(`/loans/${input.id}/close-early`, {
        settlementAmount: input.settlementAmount,
        reference: input.reference,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: loanKeys.all });
      void qc.invalidateQueries({ queryKey: loanKeys.detail(vars.id) });
    },
  });
}

export interface BulkPaymentRow {
  loanNumber?: string;
  loanId?: string;
  amount: number;
  paidOn?: string;
  reference?: string;
}

export interface BulkPaymentRowResult {
  index: number;
  loanNumber: string;
  loanId: string | null;
  ok: boolean;
  paymentId?: string;
  error?: string;
}

export interface BulkPaymentResponse {
  results: BulkPaymentRowResult[];
  succeeded: number;
  failed: number;
}

export function useRecordPaymentsBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rows: BulkPaymentRow[]; stopOnError?: boolean }) =>
      getApiClient().post<BulkPaymentResponse>("/loans/payments/bulk", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: loanKeys.all });
      void qc.invalidateQueries({ queryKey: ["accounting"] });
    },
  });
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      amount: number;
      paidOn?: string;
      reference?: string;
    }) =>
      getApiClient().post<LoanPayment>(`/loans/${input.loanId}/payments`, {
        amount: input.amount,
        paidOn: input.paidOn,
        reference: input.reference,
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: loanKeys.detail(vars.loanId) });
    },
  });
}

// ─── Penalty waive (FRD Phase A) ─────────────────────────────────────

export function useLoanPenalties(loanId: string | null) {
  return useQuery({
    queryKey: loanKeys.penalties(loanId ?? ""),
    queryFn: () =>
      getApiClient().get<LoanPenaltyTotals>(`/loans/${loanId}/penalties`),
    enabled: Boolean(loanId),
    staleTime: 15_000,
  });
}

export function useLoanPenaltyWaivers(loanId: string | null) {
  return useQuery({
    queryKey: loanKeys.penaltyWaivers(loanId ?? ""),
    queryFn: () =>
      getApiClient().get<PenaltyWaiver[]>(`/loans/${loanId}/penalty-waivers`),
    enabled: Boolean(loanId),
  });
}

export function useWaivePenalty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      waivedAmount: number;
      reason: string;
    }) =>
      getApiClient().post<{
        waiver: {
          id: string;
          originalPenalty: number;
          negotiatedPenalty: number;
        };
        journalEntryId: string;
      }>(`/loans/${input.loanId}/waive-penalty`, {
        waivedAmount: input.waivedAmount,
        reason: input.reason,
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: loanKeys.penalties(vars.loanId) });
      void qc.invalidateQueries({
        queryKey: loanKeys.penaltyWaivers(vars.loanId),
      });
      void qc.invalidateQueries({ queryKey: loanKeys.detail(vars.loanId) });
    },
  });
}
