/**
 * DORSI compliance hooks. Register CRUD, utilization
 * dashboard, loan-check preview, board approval, system config.
 */

import type {
  DorsiBoardApproval,
  DorsiCategory,
  DorsiLoanCheck,
  DorsiRecord,
  DorsiRecordWithCustomer,
  DorsiUtilization,
  SystemConfig,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const dorsiKeys = {
  register: ["dorsi", "register"] as const,
  utilization: ["dorsi", "utilization"] as const,
  forCustomer: (id: string) => ["dorsi", "customer", id] as const,
  config: ["dorsi", "config"] as const,
  boardApproval: (loanId: string) =>
    ["dorsi", "board-approval", loanId] as const,
};

export function useDorsiRegister() {
  return useQuery({
    queryKey: dorsiKeys.register,
    queryFn: () => getApiClient().get<DorsiRecordWithCustomer[]>("/dorsi"),
    staleTime: 60_000,
  });
}

export function useDorsiUtilization() {
  return useQuery({
    queryKey: dorsiKeys.utilization,
    queryFn: () => getApiClient().get<DorsiUtilization>("/dorsi/utilization"),
    staleTime: 30_000,
  });
}

export function useDorsiForCustomer(customerId: string | null) {
  return useQuery({
    queryKey: dorsiKeys.forCustomer(customerId ?? ""),
    queryFn: () =>
      getApiClient().get<DorsiRecord | null>(`/dorsi/customer/${customerId}`),
    enabled: Boolean(customerId),
    // 404 returns null — caller should not retry indefinitely.
    retry: false,
  });
}

export function useDorsiSystemConfig() {
  return useQuery({
    queryKey: dorsiKeys.config,
    queryFn: () => getApiClient().get<SystemConfig>("/dorsi/config"),
  });
}

export function useTagDorsi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId: string;
      category: DorsiCategory;
      basis: string;
    }) => getApiClient().post<DorsiRecord>("/dorsi", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dorsi"] }),
  });
}

export function useDeactivateDorsi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      getApiClient().post<DorsiRecord>(`/dorsi/${input.id}/deactivate`, {
        reason: input.reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dorsi"] }),
  });
}

export function useReviewDorsi() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getApiClient().post<DorsiRecord>(`/dorsi/${id}/review`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dorsi"] }),
  });
}

export function useCheckDorsiLoan() {
  return useMutation({
    mutationFn: (input: { customerId: string; principal: number }) =>
      getApiClient().post<DorsiLoanCheck>("/dorsi/check", input),
  });
}

/** Fuzzy name screen against the active DORSI register. */
export interface DorsiNameMatch {
  recordId: string;
  customerId: string;
  customerName: string;
  category: DorsiCategory;
  similarity: number;
  reason: string;
}

export function useScreenDorsiByName() {
  return useMutation({
    mutationFn: (name: string) =>
      getApiClient().post<DorsiNameMatch[]>("/dorsi/screen-by-name", { name }),
  });
}

export function useRecordDorsiBoardApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      meetingDate: string;
      minutesRef?: string;
      note?: string;
    }) =>
      getApiClient().post<DorsiBoardApproval>("/dorsi/board-approval", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dorsi"] }),
  });
}

export function useUpdateSystemConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { companyTotalEquity: number }) =>
      getApiClient().request<{ companyTotalEquity: number }>("/dorsi/config", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dorsi"] }),
  });
}
