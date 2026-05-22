import type {
  AccrualJobResult,
  CollectionNote,
  CollectionNoteType,
  OverdueRow,
  PromiseStatus,
  PromiseToPay,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const collectionsKeys = {
  queue: ["collections", "queue"] as const,
  notes: (loanId: string) => ["collections", "notes", loanId] as const,
  promises: (loanId: string) => ["collections", "promises", loanId] as const,
};

export function useOverdueQueue() {
  return useQuery({
    queryKey: collectionsKeys.queue,
    queryFn: () => getApiClient().get<OverdueRow[]>("/collections/queue"),
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
      qc.invalidateQueries({ queryKey: ["collections"] });
      qc.invalidateQueries({ queryKey: ["accounting"] });
    },
  });
}
