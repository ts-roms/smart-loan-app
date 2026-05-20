import type {
  Customer,
  KycDocumentType,
  KycSubmission,
  KycValidationResult,
  LoanApplication,
  LoanApplyInput,
  PaymentIntent,
} from '@loan/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApiClient } from '../client.js';

export const portalKeys = {
  me: ['portal', 'me'] as const,
  loans: ['portal', 'loans'] as const,
  loan: (id: string) => ['portal', 'loans', id] as const,
  kyc: ['portal', 'kyc'] as const,
};

export interface PortalMe {
  customer: Customer;
  score: { score: number; tier: string; computedAt: string } | null;
}

export function usePortalMe() {
  return useQuery({
    queryKey: portalKeys.me,
    queryFn: () => getApiClient().get<PortalMe>('/portal/me'),
  });
}

export function usePortalLoans() {
  return useQuery({
    queryKey: portalKeys.loans,
    queryFn: () => getApiClient().get<LoanApplication[]>('/portal/loans'),
  });
}

export function usePortalLoan(id: string | null) {
  return useQuery({
    queryKey: portalKeys.loan(id ?? ''),
    queryFn: () => getApiClient().get<LoanApplication>(`/portal/loans/${id}`),
    enabled: Boolean(id),
  });
}

export function usePortalApplyLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<LoanApplyInput, 'customerId'>) =>
      getApiClient().post<LoanApplication>('/portal/loans/apply', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.loans }),
  });
}

export interface PortalKycResponse {
  docs: KycSubmission[];
  status: KycValidationResult;
}

export function usePortalKyc() {
  return useQuery({
    queryKey: portalKeys.kyc,
    queryFn: () => getApiClient().get<PortalKycResponse>('/portal/kyc'),
  });
}

export function usePortalSubmitKyc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentType: KycDocumentType; documentUrl: string; notes?: string }) =>
      getApiClient().post<KycSubmission>('/portal/kyc', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.kyc }),
  });
}

export function usePortalCreatePaymentIntent() {
  return useMutation({
    mutationFn: (input: { loanId: string; amount: number }) =>
      getApiClient().post<PaymentIntent>('/portal/payments/intents', input),
  });
}

export function usePortalPaymentIntent(id: string | null, opts?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ['portal', 'payment-intent', id ?? ''],
    queryFn: () => getApiClient().get<PaymentIntent>(`/portal/payments/intents/${id}`),
    enabled: Boolean(id),
    refetchInterval: opts?.refetchInterval,
  });
}
