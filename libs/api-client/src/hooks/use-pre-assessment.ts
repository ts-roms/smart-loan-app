import type {
  PortalPreAssessmentInput,
  PreAssessment,
  PreAssessmentInput,
  PreAssessmentSource,
  PreAssessmentVerdict,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";
import { toQueryString } from "../query-string";

/**
 * Pre-assessment — run the decisioning rules before an application exists.
 *
 * Two surfaces, two sets of hooks. The staff hooks hit /pre-assessments and
 * can assess anyone (or a walk-in with no customer record); the portal
 * hooks hit /portal/pre-assessments, where the subject is always the
 * logged-in borrower.
 *
 * Not to be confused with `useDryRunLoan` in use-loans.ts: that previews an
 * in-flight application inside the officer's new-loan wizard and persists
 * nothing. These create a record.
 */

export const preAssessmentKeys = {
  all: ["pre-assessments"] as const,
  list: (filter?: PreAssessmentFilter) =>
    [...preAssessmentKeys.all, "list", filter ?? {}] as const,
  detail: (id: string) => [...preAssessmentKeys.all, "detail", id] as const,
  portal: ["portal", "pre-assessments"] as const,
};

export interface PreAssessmentFilter {
  customerId?: string;
  source?: PreAssessmentSource;
  verdict?: PreAssessmentVerdict;
  /** Matches the number ("PA-2026-000123") or a prospect's name. */
  q?: string;
  take?: number;
}

// ─── staff ────────────────────────────────────────────────────────

export function usePreAssessments(filter?: PreAssessmentFilter) {
  return useQuery({
    queryKey: preAssessmentKeys.list(filter),
    queryFn: () =>
      getApiClient().get<PreAssessment[]>(
        `/pre-assessments${toQueryString(filter)}`,
      ),
  });
}

export function usePreAssessment(idOrNumber: string | null) {
  return useQuery({
    queryKey: preAssessmentKeys.detail(idOrNumber ?? ""),
    queryFn: () =>
      getApiClient().get<PreAssessment>(`/pre-assessments/${idOrNumber}`),
    enabled: Boolean(idOrNumber),
  });
}

/**
 * Run and save an assessment. Unlike the dry-run this is a write, so it is
 * deliberately NOT wired to a debounced effect — the officer presses a
 * button, and each press is a row.
 */
export function useRunPreAssessment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PreAssessmentInput) =>
      getApiClient().post<PreAssessment>("/pre-assessments", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: preAssessmentKeys.all }),
  });
}

// ─── borrower portal ──────────────────────────────────────────────

export function usePortalPreAssessments() {
  return useQuery({
    queryKey: preAssessmentKeys.portal,
    queryFn: () =>
      getApiClient().get<PreAssessment[]>("/portal/pre-assessments"),
  });
}

export function usePortalPreAssess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PortalPreAssessmentInput) =>
      getApiClient().post<PreAssessment>("/portal/pre-assessments", input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: preAssessmentKeys.portal }),
  });
}
