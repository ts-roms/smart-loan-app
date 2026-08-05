import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

/**
 * Scoring catalog — the admin-editable credit survey.
 *
 * Factor point values are NOT sent by the client. The server derives
 * them from relative weights against a fixed total and returns them on
 * the list response, so the builder can show what a weight is worth
 * without re-implementing the apportionment — which is precisely how
 * the UI and the scorer would drift apart on what a factor is worth.
 */

export const scoringCatalogKeys = {
  all: ["scoring", "catalog"] as const,
};

export type SurveyQuestionKind = "CHOICE" | "NUMBER" | "BOOLEAN";

export interface CatalogQuestion {
  id: string;
  key: string;
  kind: SurveyQuestionKind;
  label: string;
  help: string | null;
  category: string | null;
  order: number;
  active: boolean;
  config: unknown;
}

export interface CatalogFactorRow {
  id: string;
  key: string;
  label: string;
  /** Relative share — only ratios between factors matter. */
  weight: number;
  /** Derived from loan history rather than a survey answer. */
  computed: boolean;
  order: number;
  active: boolean;
  /** Server-resolved points. Null when inactive (contributes nothing). */
  maxPoints: number | null;
  questions: CatalogQuestion[];
}

export interface ScoringCatalogResponse {
  /** The fixed raw-score ceiling weights normalize onto. */
  totalPoints: number;
  factors: CatalogFactorRow[];
}

export function useScoringCatalog() {
  return useQuery({
    queryKey: scoringCatalogKeys.all,
    queryFn: () =>
      getApiClient().get<ScoringCatalogResponse>("/scoring/catalog"),
  });
}

/** Every mutation invalidates the whole catalog — edits reshuffle points. */
function useCatalogMutation<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
): ReturnType<typeof useMutation<unknown, Error, TArgs>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, TArgs>({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scoringCatalogKeys.all });
      // The survey page renders from the catalog too. Key must match
      // useSurveyQuestions exactly — ["scoring", "questions"] matched
      // nothing, so an edited catalog left the borrower-facing survey
      // showing the old questions until its hour-long staleTime ran out.
      void qc.invalidateQueries({ queryKey: ["scoring", "survey-questions"] });
    },
  });
}

export interface FactorCreateInput {
  key: string;
  label: string;
  weight: number;
  computed?: boolean;
}

export function useCreateSurveyFactor() {
  return useCatalogMutation<FactorCreateInput>((input) =>
    getApiClient().post("/scoring/catalog/factors", input),
  );
}

export function useUpdateSurveyFactor() {
  return useCatalogMutation<{
    id: string;
    patch: Partial<Omit<FactorCreateInput, "key">> & { active?: boolean };
  }>(({ id, patch }) =>
    getApiClient().request(`/scoring/catalog/factors/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
}

export function useDeleteSurveyFactor() {
  return useCatalogMutation<string>((id) =>
    getApiClient().request(`/scoring/catalog/factors/${id}`, {
      method: "DELETE",
    }),
  );
}

export interface QuestionCreateInput {
  key: string;
  kind: SurveyQuestionKind;
  label: string;
  help?: string | null;
  category?: string | null;
  factorId: string;
  config: unknown;
}

export function useCreateSurveyQuestion() {
  return useCatalogMutation<QuestionCreateInput>((input) =>
    getApiClient().post("/scoring/catalog/questions", input),
  );
}

export function useUpdateSurveyQuestion() {
  return useCatalogMutation<{
    id: string;
    patch: Partial<Omit<QuestionCreateInput, "key">> & { active?: boolean };
  }>(({ id, patch }) =>
    getApiClient().request(`/scoring/catalog/questions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
}

export function useDeleteSurveyQuestion() {
  return useCatalogMutation<string>((id) =>
    getApiClient().request(`/scoring/catalog/questions/${id}`, {
      method: "DELETE",
    }),
  );
}

export function useReorderSurveyQuestions() {
  return useCatalogMutation<string[]>((ids) =>
    getApiClient().post("/scoring/catalog/questions/reorder", { ids }),
  );
}
