/**
 * Annual / renewable document hooks (FRD §3.8). Per-loan + cross-loan
 * dashboard queries.
 */

import type {
  AnnualDocument,
  AnnualDocumentCreateInput,
  ExpiringAnnualDocument,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const annualDocKeys = {
  forLoan: (loanId: string) => ["annual-docs", "loan", loanId] as const,
  expiring: (days: number) => ["annual-docs", "expiring", days] as const,
};

export function useAnnualDocs(loanId: string | null) {
  return useQuery({
    queryKey: annualDocKeys.forLoan(loanId ?? ""),
    queryFn: () =>
      getApiClient().get<AnnualDocument[]>(`/loans/${loanId}/annual-docs`),
    enabled: Boolean(loanId),
    staleTime: 60_000,
  });
}

export function useExpiringAnnualDocs(days = 30) {
  return useQuery({
    queryKey: annualDocKeys.expiring(days),
    queryFn: () =>
      getApiClient().get<ExpiringAnnualDocument[]>(
        `/annual-docs/expiring?days=${days}`,
      ),
    staleTime: 60_000,
  });
}

export function useCreateAnnualDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string } & AnnualDocumentCreateInput) =>
      getApiClient().post<AnnualDocument>(
        `/loans/${input.loanId}/annual-docs`,
        {
          type: input.type,
          name: input.name,
          documentUrl: input.documentUrl,
          effectiveFrom: input.effectiveFrom,
          expiresAt: input.expiresAt,
          notes: input.notes,
        },
      ),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({
        queryKey: annualDocKeys.forLoan(vars.loanId),
      });
      void qc.invalidateQueries({ queryKey: ["annual-docs", "expiring"] });
    },
  });
}

export function useDeleteAnnualDoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; loanId: string }) =>
      getApiClient().request<void>(`/annual-docs/${input.id}`, {
        method: "DELETE",
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({
        queryKey: annualDocKeys.forLoan(vars.loanId),
      });
      void qc.invalidateQueries({ queryKey: ["annual-docs", "expiring"] });
    },
  });
}

export function useRefreshAnnualDocStatuses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().post<{
        valid: number;
        expiringSoon: number;
        expired: number;
      }>("/annual-docs/jobs/refresh-statuses", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["annual-docs"] }),
  });
}
