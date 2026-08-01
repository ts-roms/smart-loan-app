import type { PaymentIntent } from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const paymentKeys = {
  list: (loanId: string) => ["payments", "list", loanId] as const,
  detail: (id: string) => ["payments", "detail", id] as const,
};

export function usePaymentIntents(loanId: string | null) {
  return useQuery({
    queryKey: paymentKeys.list(loanId ?? ""),
    queryFn: () =>
      getApiClient().get<PaymentIntent[]>(`/payments/intents?loanId=${loanId}`),
    enabled: Boolean(loanId),
  });
}

export function usePaymentIntent(
  id: string | null,
  opts?: { refetchInterval?: number },
) {
  return useQuery({
    queryKey: paymentKeys.detail(id ?? ""),
    queryFn: () => getApiClient().get<PaymentIntent>(`/payments/intents/${id}`),
    enabled: Boolean(id),
    refetchInterval: opts?.refetchInterval,
  });
}

export function useCreatePaymentIntent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      amount: number;
      description?: string;
    }) => getApiClient().post<PaymentIntent>("/payments/intents", input),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: paymentKeys.list(vars.loanId) });
      void qc.invalidateQueries({ queryKey: ["loans", "detail", vars.loanId] });
    },
  });
}
