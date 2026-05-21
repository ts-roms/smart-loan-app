/**
 * Demand letter hooks (FRD §3.6). Candidate identification, batch draft,
 * dispatch, and close (RESPONDED / WAIVED).
 */

import type {
  DemandCandidate,
  DemandLetter,
  DemandLetterStage,
  DemandLetterStatus,
  DemandLetterWithLoan,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client.js";

export const demandLetterKeys = {
  candidates: (stage: DemandLetterStage) =>
    ["demand-letters", "candidates", stage] as const,
  list: (filter: {
    stage?: DemandLetterStage;
    status?: DemandLetterStatus;
    loanId?: string;
  }) => ["demand-letters", "list", filter] as const,
  detail: (id: string) => ["demand-letters", "detail", id] as const,
};

export function useDemandCandidates(
  stage: DemandLetterStage | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: stage
      ? demandLetterKeys.candidates(stage)
      : ["demand-letters", "candidates", "none"],
    queryFn: () =>
      getApiClient().get<DemandCandidate[]>(
        `/demand-letters/candidates?stage=${stage}`,
      ),
    enabled: Boolean(stage) && (options?.enabled ?? true),
    staleTime: 30_000,
  });
}

export function useDemandLetters(
  filter: {
    stage?: DemandLetterStage;
    status?: DemandLetterStatus;
    loanId?: string;
  } = {},
) {
  return useQuery({
    queryKey: demandLetterKeys.list(filter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.stage) params.set("stage", filter.stage);
      if (filter.status) params.set("status", filter.status);
      if (filter.loanId) params.set("loanId", filter.loanId);
      const qs = params.toString();
      return getApiClient().get<DemandLetterWithLoan[]>(
        `/demand-letters${qs ? `?${qs}` : ""}`,
      );
    },
    staleTime: 15_000,
  });
}

export function useDemandLetter(id: string | null) {
  return useQuery({
    queryKey: demandLetterKeys.detail(id ?? ""),
    queryFn: () => getApiClient().get<DemandLetter>(`/demand-letters/${id}`),
    enabled: Boolean(id),
  });
}

export function useDraftDemandLetters() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      loanIds: string[];
      stage: DemandLetterStage;
      paymentDeadlineDays?: number;
    }) =>
      getApiClient().post<{ created: number; letters: DemandLetter[] }>(
        "/demand-letters/batch",
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["demand-letters"] });
    },
  });
}

export function useApproveDemandLetter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; note?: string }) =>
      getApiClient().post<DemandLetter>(`/demand-letters/${input.id}/approve`, {
        note: input.note,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["demand-letters"] }),
  });
}

export function useDispatchDemandLetter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; channel: string; ref?: string }) =>
      getApiClient().post<DemandLetter>(
        `/demand-letters/${input.id}/dispatch`,
        { channel: input.channel, ref: input.ref },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["demand-letters"] }),
  });
}

export function useCloseDemandLetter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      status: "RESPONDED" | "WAIVED";
      reason: string;
    }) =>
      getApiClient().post<DemandLetter>(`/demand-letters/${input.id}/close`, {
        status: input.status,
        reason: input.reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["demand-letters"] }),
  });
}
