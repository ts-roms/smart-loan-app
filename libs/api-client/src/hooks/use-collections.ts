import type {
  AccrualJobResult,
  AssignableCollector,
  CollectionNote,
  CollectionNoteType,
  CollectorWorkload,
  OverdueRow,
  PromiseStatus,
  PromiseToPay,
  QueueScope,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const collectionsKeys = {
  // Scoped: a collector's own queue and the full worklist are different
  // responses and must not share a cache entry.
  queue: (scope: QueueScope = "all") =>
    ["collections", "queue", scope] as const,
  collectors: ["collections", "collectors"] as const,
  workload: ["collections", "workload"] as const,
  notes: (loanId: string) => ["collections", "notes", loanId] as const,
  promises: (loanId: string) => ["collections", "promises", loanId] as const,
};

export function useOverdueQueue(scope: QueueScope = "all") {
  return useQuery({
    queryKey: collectionsKeys.queue(scope),
    queryFn: () =>
      getApiClient().get<OverdueRow[]>(`/collections/queue?scope=${scope}`),
  });
}

/** Users who may hold accounts — for the assign picker. */
export function useAssignableCollectors() {
  return useQuery({
    queryKey: collectionsKeys.collectors,
    queryFn: () =>
      getApiClient().get<AssignableCollector[]>("/collections/collectors"),
    staleTime: 5 * 60_000,
  });
}

/** How many accounts each collector is carrying. */
export function useCollectorWorkload() {
  return useQuery({
    queryKey: collectionsKeys.workload,
    queryFn: () =>
      getApiClient().get<CollectorWorkload[]>("/collections/workload"),
  });
}

/**
 * Assign or reassign an account.
 *
 * Invalidates every queue scope, not just the one on screen: moving an
 * account changes the unassigned pool, the new owner's queue, and the
 * old owner's, and the supervisor is usually looking at one while
 * changing another.
 */
export function useAssignAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      /** A user id or an email — the endpoint accepts either. */
      collector: string;
      note?: string;
    }) =>
      getApiClient().request(`/collections/loans/${input.loanId}/assignee`, {
        method: "PUT",
        body: JSON.stringify({
          collector: input.collector,
          note: input.note,
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["collections", "queue"] });
      void qc.invalidateQueries({ queryKey: collectionsKeys.workload });
    },
  });
}

export function useUnassignAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (loanId: string) =>
      getApiClient().request(`/collections/loans/${loanId}/assignee`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["collections", "queue"] });
      void qc.invalidateQueries({ queryKey: collectionsKeys.workload });
    },
  });
}

export function useLoanNotes(loanId: string | null) {
  return useQuery({
    queryKey: collectionsKeys.notes(loanId ?? ""),
    queryFn: () =>
      getApiClient().get<CollectionNote[]>(
        `/collections/loans/${loanId}/notes`,
      ),
    enabled: Boolean(loanId),
  });
}

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      type: CollectionNoteType;
      body: string;
    }) =>
      getApiClient().post<CollectionNote>(
        `/collections/loans/${input.loanId}/notes`,
        { type: input.type, body: input.body },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: collectionsKeys.notes(vars.loanId) }),
  });
}

export function useLoanPromises(loanId: string | null) {
  return useQuery({
    queryKey: collectionsKeys.promises(loanId ?? ""),
    queryFn: () =>
      getApiClient().get<PromiseToPay[]>(
        `/collections/loans/${loanId}/promises`,
      ),
    enabled: Boolean(loanId),
  });
}

export function useCreatePromise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      amount: number;
      promisedDate: string;
      note?: string;
    }) =>
      getApiClient().post<PromiseToPay>(
        `/collections/loans/${input.loanId}/promises`,
        {
          amount: input.amount,
          promisedDate: input.promisedDate,
          note: input.note,
        },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: collectionsKeys.promises(vars.loanId) }),
  });
}

export function useResolvePromise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      loanId: string;
      status: PromiseStatus;
    }) =>
      getApiClient().post<PromiseToPay>(
        `/collections/promises/${input.id}/resolve`,
        { status: input.status },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: collectionsKeys.promises(vars.loanId) }),
  });
}

export function useAccrueLateFees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().post<AccrualJobResult>(
        "/collections/jobs/accrue-late-fees",
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: ["accounting"] });
    },
  });
}
