import type {
  CreditScore,
  CreditScoreResult,
  SurveyQuestion,
} from '@loan/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApiClient } from '../client.js';

export function useSurveyQuestions() {
  return useQuery({
    queryKey: ['scoring', 'survey-questions'],
    queryFn: () => getApiClient().get<SurveyQuestion[]>('/scoring/survey/questions'),
    staleTime: 60 * 60 * 1000, // questions rarely change
  });
}

export function useCustomerScore(customerId: string | null) {
  return useQuery({
    queryKey: ['scoring', 'customer', customerId],
    queryFn: () =>
      getApiClient().get<CreditScore>(`/scoring/customers/${customerId}/score`),
    enabled: Boolean(customerId),
    retry: false, // 404 is normal pre-survey; don't hammer
  });
}

export function useSubmitSurvey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId: string;
      answers: Record<string, string | number | boolean>;
    }) =>
      getApiClient().post<CreditScoreResult & { surveyId: string }>(
        '/scoring/survey/submit',
        input,
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['scoring', 'customer', vars.customerId] });
    },
  });
}
