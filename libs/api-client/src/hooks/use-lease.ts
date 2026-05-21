/**
 * Lease-to-Own hooks (FRD §3.5). Per-loan agreement state + the four
 * terminal transitions (buyout, pull-out, return, extend).
 */

import type {
  LeaseAgreement,
  LeaseAgreementWithLoan,
  LeaseStatus,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client.js";

export const leaseKeys = {
  list: (status?: LeaseStatus) => ["lease", "list", status ?? "ALL"] as const,
  detail: (loanId: string) => ["lease", "detail", loanId] as const,
};

export function useLeases(status?: LeaseStatus) {
  return useQuery({
    queryKey: leaseKeys.list(status),
    queryFn: () =>
      getApiClient().get<LeaseAgreementWithLoan[]>(
        status ? `/lease?status=${status}` : "/lease",
      ),
    staleTime: 30_000,
  });
}

export function useLease(loanId: string | null) {
  return useQuery({
    queryKey: leaseKeys.detail(loanId ?? ""),
    queryFn: () => getApiClient().get<LeaseAgreement>(`/lease/${loanId}`),
    enabled: Boolean(loanId),
    retry: false,
  });
}

export function useBuyoutLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; amountPaid: number }) =>
      getApiClient().post<{
        agreement: LeaseAgreement;
        journalEntryId: string;
      }>(`/lease/${input.loanId}/buyout`, {
        amountPaid: input.amountPaid,
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["lease"] });
      qc.invalidateQueries({ queryKey: ["loans", "detail", vars.loanId] });
    },
  });
}

export function usePullOutLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; reason: string }) =>
      getApiClient().post<LeaseAgreement>(`/lease/${input.loanId}/pull-out`, {
        reason: input.reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lease"] }),
  });
}

export function useReturnLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; reason: string }) =>
      getApiClient().post<LeaseAgreement>(`/lease/${input.loanId}/return`, {
        reason: input.reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lease"] }),
  });
}

export function useExtendLease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { loanId: string; reason: string }) =>
      getApiClient().post<LeaseAgreement>(`/lease/${input.loanId}/extend`, {
        reason: input.reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lease"] }),
  });
}
