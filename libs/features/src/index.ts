/**
 * Feature flag registry. Centralizes toggles so we don't sprinkle string
 * literals across the codebase. Flags are evaluated server-side via the
 * /features endpoint, and the web app caches the result in TanStack Query.
 */
export type FeatureFlag =
  | 'kyc.required'
  | 'scoring.behavioral'
  | 'loans.autoApproveTierA'
  | 'survey.dynamicQuestions';

export const DEFAULTS: Record<FeatureFlag, boolean> = {
  'kyc.required': true,
  'scoring.behavioral': true,
  'loans.autoApproveTierA': false,
  'survey.dynamicQuestions': false,
};

export function isEnabled(flags: Partial<Record<FeatureFlag, boolean>>, flag: FeatureFlag): boolean {
  return flags[flag] ?? DEFAULTS[flag];
}
