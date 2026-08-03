/**
 * Repossession workflow hooks.
 *
 * The workflow has 9 state transitions; each gets its own mutation hook
 * for type-safe invalidation. The list / detail / outstanding queries
 * power the dashboard + state-machine UI.
 */

import type {
  RepossessionCase,
  RepossessionCaseWithLoan,
  RepossessionStatus,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const repossessionKeys = {
  list: (filter: { status?: RepossessionStatus; loanId?: string }) =>
    ["repossession", "list", filter] as const,
  detail: (id: string) => ["repossession", "detail", id] as const,
  outstanding: (id: string) => ["repossession", "outstanding", id] as const,
};

export function useRepossessionCases(
  filter: {
    status?: RepossessionStatus;
    loanId?: string;
  } = {},
) {
  return useQuery({
    queryKey: repossessionKeys.list(filter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.status) params.set("status", filter.status);
      if (filter.loanId) params.set("loanId", filter.loanId);
      const qs = params.toString();
      return getApiClient().get<RepossessionCaseWithLoan[]>(
        `/repossession${qs ? `?${qs}` : ""}`,
      );
    },
    staleTime: 15_000,
  });
}

export function useRepossessionCase(id: string | null) {
  return useQuery({
    queryKey: repossessionKeys.detail(id ?? ""),
    queryFn: () => getApiClient().get<RepossessionCase>(`/repossession/${id}`),
    enabled: Boolean(id),
  });
}

export function useRepossessionOutstanding(id: string | null) {
  return useQuery({
    queryKey: repossessionKeys.outstanding(id ?? ""),
    queryFn: () =>
      getApiClient().get<{
        outstandingPrincipal: number;
        outstandingPenalties: number;
        totalOutstanding: number;
      }>(`/repossession/${id}/outstanding`),
    enabled: Boolean(id),
  });
}

export function useOpenRepossession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; reason: string }) =>
      getApiClient().post<RepossessionCase>("/repossession", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repossession"] }),
  });
}

/** Single-action helper — pick the endpoint by status target. */
type RepoAdvanceAction =
  | "bm-approve"
  | "credit-approve"
  | "legal-approve"
  | "assign-agent"
  | "recover"
  | "auction"
  | "cancel";

export function useAdvanceRepossession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      action: RepoAdvanceAction;
      body: Record<string, unknown>;
    }) =>
      getApiClient().post<
        | RepossessionCase
        | {
            case: RepossessionCase;
            deficiency: number;
            surplus: number;
            journalEntryId: string;
          }
      >(`/repossession/${input.id}/${input.action}`, input.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repossession"] }),
  });
}
