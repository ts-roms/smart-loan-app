import type { Customer, CustomerCreateInput, CustomerSummary } from '@loan/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApiClient } from '../client.js';

export const customerKeys = {
  all: ['customers'] as const,
  detail: (id: string) => [...customerKeys.all, 'detail', id] as const,
  summary: (id: string) => [...customerKeys.all, 'summary', id] as const,
};

export function useCustomers() {
  return useQuery({
    queryKey: customerKeys.all,
    queryFn: () => getApiClient().get<Customer[]>('/customers'),
  });
}

export function useCustomer(id: string | null) {
  return useQuery({
    queryKey: customerKeys.detail(id ?? ''),
    queryFn: () => getApiClient().get<Customer>(`/customers/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * Rollup endpoint for the drawer — base customer + active-loans count +
 * outstanding principal. Cheaper than fetching every loan separately.
 */
export function useCustomerSummary(id: string | null) {
  return useQuery({
    queryKey: customerKeys.summary(id ?? ''),
    queryFn: () => getApiClient().get<CustomerSummary>(`/customers/${id}/summary`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerCreateInput) =>
      getApiClient().post<Customer>('/customers', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: customerKeys.all }),
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: Partial<CustomerCreateInput> }) =>
      getApiClient().request<Customer>(`/customers/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify(input.patch),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: customerKeys.all });
      qc.invalidateQueries({ queryKey: customerKeys.detail(vars.id) });
    },
  });
}
