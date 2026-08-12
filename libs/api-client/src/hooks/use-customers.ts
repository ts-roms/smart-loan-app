import type {
  Customer,
  CustomerCreateInput,
  CustomerExposure,
  CustomerListItem,
  CustomerListQuery,
  CustomerSummary,
  Paginated,
  RepeatEligibility,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";
import { toQueryString } from "../query-string";

export const customerKeys = {
  all: ["customers"] as const,
  // Filters are part of the key so each search is cached separately and
  // switching back to a previous one is instant. Still prefixed with
  // `all`, so the existing `invalidateQueries({ queryKey: all })` after a
  // create or edit continues to refresh every filtered view.
  list: (filter?: CustomerListQuery) =>
    [...customerKeys.all, "list", filter ?? {}] as const,
  detail: (id: string) => [...customerKeys.all, "detail", id] as const,
  summary: (id: string) => [...customerKeys.all, "summary", id] as const,
  repeat: (id: string) => [...customerKeys.all, "repeat", id] as const,
  exposure: (id: string) => [...customerKeys.all, "exposure", id] as const,
};

/**
 * Customer list as a plain array — the pool shape.
 *
 * Rows carry `hasLoans` (an approved/disbursed/active loan exists) and
 * `hasDefaulted` (a loan went bad at some point), so pickers can rank and
 * warn without fetching `/loans`.
 *
 * The endpoint is paginated, but most callers here are pickers and
 * queues that want "the customers", not "a page of customers". `select`
 * unwraps the envelope for them, so `useCustomers()` still returns the
 * 200 most recent exactly as it did before pagination existed. Use
 * {@link useCustomersPage} where the page metadata matters.
 *
 * Both hooks share a query key, so a screen using each fetches once.
 */
/**
 * Archive or restore a customer — the soft delete. Nothing is removed:
 * the record leaves the pickers and the default list and stops being
 * eligible for new loans, and every loan, payment and ledger line that
 * points at it is untouched. Refused (409) while a loan is still open.
 */
export function useArchiveCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; archived: boolean; reason?: string }) =>
      getApiClient().request<{
        ok: true;
        customerId: string;
        number: string;
        archivedAt: string | null;
      }>(`/customers/${input.id}/archive`, {
        method: "PATCH",
        body: JSON.stringify({
          archived: input.archived,
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: customerKeys.all }),
  });
}

export function useCustomers(filter?: CustomerListQuery) {
  return useQuery({
    queryKey: customerKeys.list(filter),
    queryFn: () =>
      getApiClient().get<Paginated<CustomerListItem>>(
        `/customers${toQueryString(filter)}`,
      ),
    select: (page) => page.rows,
    placeholderData: (previous) => previous,
  });
}

/**
 * Customer list with its page metadata — total, page, totalPages.
 *
 * `placeholderData` keeps the previous page's rows on screen while a new
 * query is in flight, so typing in a search box or stepping a page
 * doesn't flash the table back to a skeleton.
 */
export function useCustomersPage(filter?: CustomerListQuery) {
  return useQuery({
    queryKey: customerKeys.list(filter),
    queryFn: () =>
      getApiClient().get<Paginated<CustomerListItem>>(
        `/customers${toQueryString(filter)}`,
      ),
    placeholderData: (previous) => previous,
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
 * Consolidated exposure — everything this borrower owes across every
 * loan they hold, with the per-loan breakdown behind it.
 *
 * Takes the customer UUID or the human "CUST-..." number; the endpoint
 * resolves either.
 *
 * Short staleTime because a payment posted a minute ago changes the
 * answer, and this is the number an officer approves against — a stale
 * exposure is the one kind of wrong here that costs money.
 */
export function useCustomerExposure(idOrNumber: string | null) {
  return useQuery({
    queryKey: customerKeys.exposure(idOrNumber ?? ""),
    queryFn: () =>
      getApiClient().get<CustomerExposure>(`/customers/${idOrNumber}/exposure`),
    enabled: Boolean(idOrNumber),
    staleTime: 10_000,
  });
}

/**
 * Repeat-borrower eligibility. Returns null-safe data:
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
      void qc.invalidateQueries({ queryKey: customerKeys.all });
      void qc.invalidateQueries({ queryKey: customerKeys.detail(vars.id) });
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
      if (!res.dryRun)
        void qc.invalidateQueries({ queryKey: customerKeys.all });
    },
  });
}
