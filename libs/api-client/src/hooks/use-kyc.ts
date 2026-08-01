import type { KycSubmission, KycValidationResult } from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const kycKeys = {
  forCustomer: (customerId: string) => ["kyc", "customer", customerId] as const,
  status: (customerId: string) =>
    ["kyc", "customer", customerId, "status"] as const,
};

export function useKycForCustomer(customerId: string | null) {
  return useQuery({
    queryKey: kycKeys.forCustomer(customerId ?? ""),
    queryFn: () =>
      getApiClient().get<KycSubmission[]>(`/kyc?customerId=${customerId}`),
    enabled: Boolean(customerId),
  });
}

export function useKycStatus(customerId: string | null) {
  return useQuery({
    queryKey: kycKeys.status(customerId ?? ""),
    queryFn: () =>
      getApiClient().get<KycValidationResult>(
        `/kyc/customers/${customerId}/status`,
      ),
    enabled: Boolean(customerId),
  });
}

export function useSubmitKyc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId: string;
      documentType: KycSubmission["documentType"];
      documentUrl: string;
      notes?: string;
    }) => getApiClient().post<KycSubmission>("/kyc", input),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({
        queryKey: kycKeys.forCustomer(vars.customerId),
      });
      void qc.invalidateQueries({ queryKey: kycKeys.status(vars.customerId) });
    },
  });
}

export function useDecideKyc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      customerId: string;
      status: "VERIFIED" | "REJECTED";
      reason?: string;
    }) =>
      getApiClient().post<KycSubmission>(`/kyc/${input.id}/decide`, {
        status: input.status,
        reason: input.reason,
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({
        queryKey: kycKeys.forCustomer(vars.customerId),
      });
      void qc.invalidateQueries({ queryKey: kycKeys.status(vars.customerId) });
    },
  });
}
