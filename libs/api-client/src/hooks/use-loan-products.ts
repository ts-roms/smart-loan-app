import type {
  LoanProduct,
  LoanProductCreateInput,
  LoanProductUpdateInput,
} from '@loan/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApiClient } from '../client.js';

export const loanProductKeys = {
  all: ['loan-products'] as const,
  byCode: (code: string) => ['loan-products', code] as const,
};

export function useLoanProducts() {
  return useQuery({
    queryKey: loanProductKeys.all,
    queryFn: () => getApiClient().get<LoanProduct[]>('/loan-products'),
  });
}

export function useLoanProduct(code: string | null) {
  return useQuery({
    queryKey: loanProductKeys.byCode(code ?? ''),
    queryFn: () => getApiClient().get<LoanProduct>(`/loan-products/${code}`),
    enabled: Boolean(code),
  });
}

export function useCreateLoanProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LoanProductCreateInput) =>
      getApiClient().post<LoanProduct>('/loan-products', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: loanProductKeys.all }),
  });
}

export function useUpdateLoanProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { code: string } & LoanProductUpdateInput) => {
      const { code, ...rest } = input;
      return getApiClient().request<LoanProduct>(`/loan-products/${code}`, {
        method: 'PATCH',
        body: JSON.stringify(rest),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: loanProductKeys.all }),
  });
}

export function useDeleteLoanProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      getApiClient().request<LoanProduct>(`/loan-products/${code}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: loanProductKeys.all }),
  });
}

export function useSeedLoanProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().post<{ created: number; existing: number }>(
        '/loan-products/seed',
        {},
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: loanProductKeys.all }),
  });
}

/** Backwards-compat alias — keep until callers migrate to useUpdateLoanProduct. */
export const useUpsertLoanProduct = useUpdateLoanProduct;
