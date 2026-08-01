/**
 * Hooks for servicing (restructure/write-off), co-makers, and decision rules.
 */
import type {
  CoMaker,
  CoMakerInput,
  DecisionRule,
  DecisionRuleInput,
  LoanApplication,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

// ─── Restructure / write-off ─────────────────────────────────────────

export interface RestructureResult {
  original: LoanApplication;
  replacement: LoanApplication;
}

export function useRestructureLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      productCode: string;
      principal: number;
      termMonths: number;
      annualInterestRate: number;
      purpose?: string;
    }) => {
      const { id, ...rest } = input;
      return getApiClient().post<RestructureResult>(
        `/loans/${id}/restructure`,
        rest,
      );
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["loans"] });
      void qc.invalidateQueries({ queryKey: ["loans", "detail", vars.id] });
    },
  });
}

export function useWriteOffLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      getApiClient().post<{ loan: LoanApplication; amount: number }>(
        `/loans/${input.id}/write-off`,
        { reason: input.reason },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["loans"] });
      void qc.invalidateQueries({ queryKey: ["loans", "detail", vars.id] });
      void qc.invalidateQueries({ queryKey: ["accounting"] });
    },
  });
}

// ─── Co-makers ───────────────────────────────────────────────────────

export function useLoanCoMakers(loanId: string | null) {
  return useQuery({
    queryKey: ["co-makers", loanId ?? ""],
    queryFn: () => getApiClient().get<CoMaker[]>(`/loans/${loanId}/co-makers`),
    enabled: Boolean(loanId),
  });
}

export function useAddCoMaker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string } & CoMakerInput) => {
      const { loanId, ...rest } = input;
      return getApiClient().post<CoMaker>(`/loans/${loanId}/co-makers`, rest);
    },
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["co-makers", vars.loanId] });
    },
  });
}

export function useRemoveCoMaker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { coMakerId: string; loanId: string }) =>
      getApiClient().request<CoMaker>(`/loans/co-makers/${input.coMakerId}`, {
        method: "DELETE",
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["co-makers", vars.loanId] }),
  });
}

// ─── Decision rules ─────────────────────────────────────────────────

export function useDecisionRules() {
  return useQuery({
    queryKey: ["decision-rules"],
    queryFn: () => getApiClient().get<DecisionRule[]>("/decision-rules"),
  });
}

export function useCreateDecisionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecisionRuleInput) =>
      getApiClient().post<DecisionRule>("/decision-rules", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["decision-rules"] }),
  });
}

export function useUpdateDecisionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & Partial<DecisionRuleInput>) => {
      const { id, ...rest } = input;
      return getApiClient().request<DecisionRule>(`/decision-rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(rest),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["decision-rules"] }),
  });
}

export function useDeleteDecisionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getApiClient().request<DecisionRule>(`/decision-rules/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["decision-rules"] }),
  });
}

export function useSeedDecisionRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().post<{ created: number; existing: number }>(
        "/decision-rules/seed",
        {},
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["decision-rules"] }),
  });
}

// ─── E-signatures ───────────────────────────────────────────────────

export function useSignAsOfficer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      signatureUrl: string;
      delegationId?: string;
    }) =>
      getApiClient().post<LoanApplication>(
        `/loans/${input.loanId}/sign-officer`,
        {
          signatureUrl: input.signatureUrl,
          delegationId: input.delegationId,
        },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["loans", "detail", vars.loanId] });
    },
  });
}

export function useSignAsBorrower(scope: "officer" | "portal" = "officer") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; signatureUrl: string }) =>
      getApiClient().post<LoanApplication>(
        scope === "portal"
          ? `/portal/loans/${input.loanId}/sign-borrower`
          : `/loans/${input.loanId}/sign-borrower`,
        { signatureUrl: input.signatureUrl },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ["loans", "detail", vars.loanId] });
      void qc.invalidateQueries({ queryKey: ["portal", "loans", vars.loanId] });
    },
  });
}
