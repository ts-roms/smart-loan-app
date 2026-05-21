import type {
  Customer,
  CustomerCreateInput,
  CustomerSummary,
  RepeatEligibility,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client.js";

export const customerKeys = {
  all: ["customers"] as const,
  detail: (id: string) => [...customerKeys.all, "detail", id] as const,
  summary: (id: string) => [...customerKeys.all, "summary", id] as const,
  repeat: (id: string) => [...customerKeys.all, "repeat", id] as const,
};

export function useCustomers() {
  return useQuery({
    queryKey: customerKeys.all,
    queryFn: () => getApiClient().get<Customer[]>("/customers"),
  });
}

export function useCustomer(id: string | null) {
  return useQuery({
    queryKey: customerKeys.detail(id ?? ""),
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
    queryKey: customerKeys.summary(id ?? ""),
    queryFn: () =>
      getApiClient().get<CustomerSummary>(`/customers/${id}/summary`),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

/**
 * Per FRD §3.1.1 repeat-borrower eligibility. Returns null-safe data:
 * the endpoint resolves even for first-time customers (eligible: false,
 * closedLoansCount: 0). Used by the smart loan application bar to nudge
 * officers toward the repeat fast-path or warn about prior defaults.
 */
export function useRepeatEligibility(id: string | null) {
  return useQuery({
    queryKey: customerKeys.repeat(id ?? ""),
    queryFn: () =>
      getApiClient().get<RepeatEligibility>(
        `/customers/${id}/repeat-eligibility`,
      ),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerCreateInput) =>
      getApiClient().post<Customer>("/customers", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: customerKeys.all }),
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: Partial<CustomerCreateInput> }) =>
      getApiClient().request<Customer>(`/customers/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input.patch),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: customerKeys.all });
      qc.invalidateQueries({ queryKey: customerKeys.detail(vars.id) });
    },
  });
}

/**
 * Per-row outcome from a bulk customer import. `dryRun` callers get
 * `ok:true` rows with no `id`/`number` (nothing was created); a real
 * commit fills those in for successfully created customers.
 */
export interface BulkCustomerRowResult {
  index: number;
  ok: boolean;
  id?: string;
  number?: string;
  error?: string;
}

export interface BulkCustomerImportResponse {
  results: BulkCustomerRowResult[];
  succeeded: number;
  failed: number;
  dryRun: boolean;
}

export interface BulkCustomerImportInput {
  rows: Array<Record<string, unknown>>;
  stopOnError?: boolean;
  dryRun?: boolean;
}

/**
 * Bulk customer import. Resolves with a per-row verdict (multi-status
 * 207). The hook invalidates the customers list on every commit so
 * newly created customers appear immediately — dry runs skip the
 * invalidation since nothing changed.
 */
export function useBulkImportCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkCustomerImportInput) =>
      getApiClient().post<BulkCustomerImportResponse>("/customers/bulk", input),
    onSuccess: (res) => {
      if (!res.dryRun) qc.invalidateQueries({ queryKey: customerKeys.all });
    },
  });
}
