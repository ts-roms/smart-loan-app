/**
 * Hooks for servicing (restructure/write-off), co-makers, and decision rules.
 */
import type {
  CoMaker,
  CoMakerInput,
  DecisionRule,
  DecisionRuleInput,
  DecisionRuleVersion,
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

/**
 * Every revision of one rule, newest first. Lazy — a rule's history is
 * only fetched when someone opens it, which is rare and deliberate.
 */
export function useDecisionRuleHistory(ruleId: string | null) {
  return useQuery({
    queryKey: ["decision-rules", ruleId, "versions"],
    queryFn: () =>
      getApiClient().get<DecisionRuleVersion[]>(
        `/decision-rules/${ruleId}/versions`,
      ),
    enabled: !!ruleId,
  });
}

/** The whole rule set as it stood at a moment. */
export function useDecisionRulesAsOf(at: string | null) {
  return useQuery({
    queryKey: ["decision-rules", "as-of", at],
    queryFn: () =>
      getApiClient().get<DecisionRuleVersion[]>(
        `/decision-rules/as-of?at=${encodeURIComponent(at!)}`,
      ),
    enabled: !!at,
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
    mutationFn: (
      input: { id: string; changeNote?: string } & Partial<DecisionRuleInput>,
    ) => {
      const { id, ...rest } = input;
      return getApiClient().request<DecisionRule>(`/decision-rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(rest),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["decision-rules"] }),
  });
}

/**
 * Retires the rule. The endpoint is still DELETE and the rule still
 * vanishes from the list, but the row and its history survive — every
 * loan whose approval cites it has to stay explainable.
 */
export function useDeleteDecisionRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: string | { id: string; changeNote?: string }) => {
      const { id, changeNote } =
        typeof input === "string"
          ? { id: input, changeNote: undefined }
          : input;
      return getApiClient().request<DecisionRule>(`/decision-rules/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ changeNote }),
      });
    },
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

// ─── Renewal ────────────────────────────────────────────────────────

export interface RenewalEligibility {
  loanNumber: string;
  eligible: boolean;
  /** Present when eligible — the balance the new loan settles. */
  payoffAmount?: number;
  /** Share of PRINCIPAL repaid, 0–1. */
  paidFraction?: number;
  reason?:
    | "NotRenewableStatus"
    | "AlreadyRenewed"
    | "InArrears"
    | "InsufficientlyPaid";
  message?: string;
  requiredFraction?: number;
  overdueInstallments?: number;
}

/**
 * Can this loan be renewed, and what would settling it cost?
 *
 * Read separately from the renew mutation so the officer sees the
 * payoff and the net proceeds BEFORE committing — "how much do I
 * actually get" is the borrower's first question, and answering it
 * after the application exists is too late to be useful.
 */
export function useRenewalEligibility(loanIdOrNumber: string | null) {
  return useQuery({
    queryKey: ["renewal-eligibility", loanIdOrNumber ?? ""],
    queryFn: () =>
      getApiClient().get<RenewalEligibility>(
        `/loans/${loanIdOrNumber}/renewal-eligibility`,
      ),
    enabled: !!loanIdOrNumber,
    // Arrears can appear between page loads; this drives a button that
    // must not offer a renewal the API will refuse.
    staleTime: 15_000,
  });
}

export function useRenewLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanIdOrNumber: string;
      productCode: string;
      principal: number;
      termMonths: number;
      annualInterestRate: number;
      purpose?: string;
    }) => {
      const { loanIdOrNumber, ...body } = input;
      return getApiClient().post<{
        loan: LoanApplication;
        payoffAmount: number;
        netProceeds: number;
      }>(`/loans/${loanIdOrNumber}/renew`, body);
    },
    onSuccess: () => {
      // The original's status and the customer's loan list both move.
      void qc.invalidateQueries({ queryKey: ["loans"] });
      void qc.invalidateQueries({ queryKey: ["renewal-eligibility"] });
    },
  });
}
