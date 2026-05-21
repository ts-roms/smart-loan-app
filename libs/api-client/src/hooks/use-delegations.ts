import type {
  Delegation,
  DelegationCreateInput,
  DelegationListForUser,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client.js";

export const delegationKeys = {
  mine: ["delegations", "mine"] as const,
  all: ["delegations", "all"] as const,
  active: ["delegations", "active"] as const,
  directory: ["delegations", "users-directory"] as const,
};

export interface DelegationUserEntry {
  id: string;
  name: string;
  email: string;
  role: string;
}

/**
 * Minimal user directory for delegation pickers and banners. Any
 * authenticated user can call this (unlike `/admin/users`).
 */
export function useDelegationUserDirectory() {
  return useQuery({
    queryKey: delegationKeys.directory,
    queryFn: () =>
      getApiClient().get<DelegationUserEntry[]>("/delegations/users/directory"),
    staleTime: 60_000,
  });
}

/** Caller's own delegations — both granted and held. */
export function useMyDelegations() {
  return useQuery({
    queryKey: delegationKeys.mine,
    queryFn: () => getApiClient().get<DelegationListForUser>("/delegations"),
  });
}

/** Active delegations the caller currently holds. Drives the banner. */
export function useActiveDelegations() {
  return useQuery({
    queryKey: delegationKeys.active,
    queryFn: () => getApiClient().get<Delegation[]>("/delegations/active"),
    staleTime: 30_000,
  });
}

/** System-wide list — admin only. */
export function useAllDelegations() {
  return useQuery({
    queryKey: delegationKeys.all,
    queryFn: () => getApiClient().get<Delegation[]>("/delegations/all"),
  });
}

export function useCreateDelegation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DelegationCreateInput) =>
      getApiClient().post<Delegation>("/delegations", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: delegationKeys.mine });
      qc.invalidateQueries({ queryKey: delegationKeys.all });
      qc.invalidateQueries({ queryKey: delegationKeys.active });
    },
  });
}

export function useRevokeDelegation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason?: string }) =>
      getApiClient().post<Delegation>(`/delegations/${input.id}/revoke`, {
        reason: input.reason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: delegationKeys.mine });
      qc.invalidateQueries({ queryKey: delegationKeys.all });
      qc.invalidateQueries({ queryKey: delegationKeys.active });
    },
  });
}

/**
 * Push an active delegation's end date later. API refuses to shorten
 * (use revoke + create-new for that). Caller is the delegator OR
 * someone with `admin.users`. Surfaces as an inline "+ 7d" button on
 * active rows.
 */
export function useExtendDelegation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; endsAt: string }) =>
      getApiClient().post<Delegation>(`/delegations/${input.id}/extend`, {
        endsAt: input.endsAt,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: delegationKeys.mine });
      qc.invalidateQueries({ queryKey: delegationKeys.all });
      qc.invalidateQueries({ queryKey: delegationKeys.active });
    },
  });
}
