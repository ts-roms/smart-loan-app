import type {
  AmortizationRow,
  KycValidationResult,
  LoanApplication,
  LoanApplyInput,
  LoanPayment,
} from '@loan/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApiClient } from '../client.js';

export const loanKeys = {
  all: ['loans'] as const,
  detail: (id: string) => [...loanKeys.all, 'detail', id] as const,
  kycStatus: (id: string) => [...loanKeys.all, 'kyc-status', id] as const,
};

export interface LoanQuote {
  monthlyPayment: number;
  totalPaid: number;
  totalInterest: number;
  schedule: AmortizationRow[];
  fees: {
    processing: number;
    documentary: number;
    total: number;
    netDisbursement: number;
  };
  method: 'DECLINING' | 'FLAT';
  frequency: 'MONTHLY' | 'BIWEEKLY' | 'WEEKLY';
  installments: number;
}

export function useLoans() {
  return useQuery({
    queryKey: loanKeys.all,
    queryFn: () => getApiClient().get<LoanApplication[]>('/loans'),
  });
}

export function useLoan(id: string | null) {
  return useQuery({
    queryKey: loanKeys.detail(id ?? ''),
    queryFn: () => getApiClient().get<LoanApplication>(`/loans/${id}`),
    enabled: Boolean(id),
  });
}

/** Per-loan KYC posture: base required docs + this product's extras. */
export function useLoanKycStatus(id: string | null) {
  return useQuery({
    queryKey: loanKeys.kycStatus(id ?? ''),
    queryFn: () => getApiClient().get<KycValidationResult>(`/loans/${id}/kyc-status`),
    enabled: Boolean(id),
  });
}

export function useQuote() {
  return useMutation({
    mutationFn: (input: {
      principal: number;
      termMonths: number;
      annualInterestRate: number;
      productCode?: string;
    }) => getApiClient().post<LoanQuote>('/loans/quote', input),
  });
}

export function useApplyLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoanApplyInput) =>
      getApiClient().post<LoanApplication>('/loans/apply', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: loanKeys.all }),
  });
}

export function useDecideLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      status: 'APPROVED' | 'REJECTED';
      reason?: string;
      overrideKyc?: boolean;
    }) =>
      getApiClient().post<LoanApplication>(`/loans/${input.id}/decide`, {
        status: input.status,
        reason: input.reason,
        overrideKyc: input.overrideKyc,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: loanKeys.all });
      qc.invalidateQueries({ queryKey: loanKeys.detail(vars.id) });
      qc.invalidateQueries({ queryKey: loanKeys.kycStatus(vars.id) });
    },
  });
}

export function useDisburseLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getApiClient().post<LoanApplication>(`/loans/${id}/disburse`, {}),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: loanKeys.all });
      qc.invalidateQueries({ queryKey: loanKeys.detail(id) });
    },
  });
}

export interface CloseEarlyResult {
  loan: LoanApplication;
  payment: LoanPayment;
  remainingPrincipal: number;
  fee: number;
  totalSettled: number;
}

export function useCloseEarlyLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; settlementAmount: number; reference?: string }) =>
      getApiClient().post<CloseEarlyResult>(`/loans/${input.id}/close-early`, {
        settlementAmount: input.settlementAmount,
        reference: input.reference,
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: loanKeys.all });
      qc.invalidateQueries({ queryKey: loanKeys.detail(vars.id) });
    },
  });
}

export interface BulkPaymentRow {
  loanNumber?: string;
  loanId?: string;
  amount: number;
  paidOn?: string;
  reference?: string;
}

export interface BulkPaymentRowResult {
  index: number;
  loanNumber: string;
  loanId: string | null;
  ok: boolean;
  paymentId?: string;
  error?: string;
}

export interface BulkPaymentResponse {
  results: BulkPaymentRowResult[];
  succeeded: number;
  failed: number;
}

export function useRecordPaymentsBulk() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rows: BulkPaymentRow[]; stopOnError?: boolean }) =>
      getApiClient().post<BulkPaymentResponse>('/loans/payments/bulk', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: loanKeys.all });
      qc.invalidateQueries({ queryKey: ['accounting'] });
    },
  });
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      amount: number;
      paidOn?: string;
      reference?: string;
    }) =>
      getApiClient().post<LoanPayment>(`/loans/${input.loanId}/payments`, {
        amount: input.amount,
        paidOn: input.paidOn,
        reference: input.reference,
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: loanKeys.detail(vars.loanId) });
    },
  });
}
