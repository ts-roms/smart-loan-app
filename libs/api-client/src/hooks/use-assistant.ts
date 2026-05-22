/**
 * Hooks for the local LLM assistant. Wraps three task-shaped endpoints
 * (explain decision, draft demand letter, summarize account) plus a
 * ping that the UI uses to detect whether Ollama is configured.
 *
 * All hooks return a small AssistantResponse shape: { text, model,
 * isMock }. The web app uses `isMock` to render a configure-Ollama
 * notice instead of pretending the canned response is real AI.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import { getApiClient } from "../client";

export interface AssistantResponse {
  text: string;
  model: string;
  isMock: boolean;
}

export interface AssistantPingResult {
  provider: "mock" | "ollama";
  model: string;
  ok: boolean;
  message: string;
}

export function useAssistantPing() {
  return useQuery({
    queryKey: ["assistant", "ping"],
    queryFn: () => getApiClient().get<AssistantPingResult>("/assistant/ping"),
    // Cheap call but no point re-running every render.
    staleTime: 60_000,
    retry: false,
  });
}

export function useExplainDecision() {
  return useMutation({
    mutationFn: (input: { loanId: string }) =>
      getApiClient().post<AssistantResponse>(
        "/assistant/explain-decision",
        input,
      ),
  });
}

export function useDraftDemandLetter() {
  return useMutation({
    mutationFn: (input: {
      loanId: string;
      stage: "FIRST" | "FINAL" | "ATTORNEY_FIRST" | "ATTORNEY_FINAL";
    }) =>
      getApiClient().post<AssistantResponse>(
        "/assistant/draft-demand-letter",
        input,
      ),
  });
}

export function useSummarizeAccount() {
  return useMutation({
    mutationFn: (input: { customerId: string }) =>
      getApiClient().post<AssistantResponse>(
        "/assistant/summarize-account",
        input,
      ),
  });
}
