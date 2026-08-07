import type {
  KycSubmission,
  KycValidationResult,
  Paginated,
  PendingKycRow,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";
import { toQueryString } from "../query-string";

export const kycKeys = {
  pending: (params: unknown) => ["kyc", "pending", params] as const,
  forCustomer: (customerId: string) => ["kyc", "customer", customerId] as const,
  status: (customerId: string) =>
    ["kyc", "customer", customerId, "status"] as const,
};

/**
 * The KYC review queue — documents waiting on a decision.
 *
 * One request, paginated, joined to the customer server-side. The page
 * used to build this from `useCustomers()` plus a `useKycForCustomer`
 * per row, which meant a request per customer and a queue that
 * included people who had submitted nothing.
 */
export function useKycPending(
  params: { page?: number; pageSize?: number } = {},
) {
  return useQuery({
    queryKey: ["kyc", "pending", params],
    queryFn: () =>
      getApiClient().get<Paginated<PendingKycRow>>(
        `/kyc/pending${toQueryString(params)}`,
      ),
  });
}

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
      /*
       * The review queue moves on both paths: a submission joins it, a
       * decision leaves it. Without this the reviewer keeps looking at
       * a row they have already actioned, and a fresh upload does not
       * appear until a reload.
       */
      void qc.invalidateQueries({ queryKey: ["kyc", "pending"] });
      // The customer's rollup status moves with it.
      void qc.invalidateQueries({ queryKey: ["customers"] });
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
      /*
       * The review queue moves on both paths: a submission joins it, a
       * decision leaves it. Without this the reviewer keeps looking at
       * a row they have already actioned, and a fresh upload does not
       * appear until a reload.
       */
      void qc.invalidateQueries({ queryKey: ["kyc", "pending"] });
      // The customer's rollup status moves with it.
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
