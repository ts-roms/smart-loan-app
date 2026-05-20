/**
 * Survey + behavioral factor catalog.
 *
 * Each factor has a maximum point value; the customer's actual contribution
 * is some fraction of that max derived from their answer. The whole-score
 * range is the sum of maxima, then linearly scaled to 300–850 (FICO-like).
 *
 * Adding / removing factors only requires updating this file — the
 * computation engine and persistence layer don't care about the catalog.
 */

export type SurveyAnswer = string | number | boolean;

export interface SurveyOption {
  /** Label shown to the customer */
  label: string;
  /** Numeric value persisted in answers */
  value: string;
  /** 0..1 — how much of the factor's max this answer contributes */
  weight: number;
}

export type SurveyQuestion =
  | {
      kind: 'choice';
      id: string;
      label: string;
      help?: string;
      options: SurveyOption[];
      factorId: string;
    }
  | {
      kind: 'number';
      id: string;
      label: string;
      help?: string;
      /** Range that maps linearly to 0..1 weight. */
      min: number;
      max: number;
      step?: number;
      factorId: string;
      /** When true, higher values give *lower* weight (e.g. existing debt). */
      inverted?: boolean;
    }
  | {
      kind: 'boolean';
      id: string;
      label: string;
      help?: string;
      /** Weight applied when answer is `true`. False contributes 0. */
      weightWhenTrue: number;
      factorId: string;
    };

export interface FactorDef {
  id: string;
  label: string;
  /** Max points this factor can contribute to the raw score. */
  maxPoints: number;
}

/**
 * Canonical factor catalog. The numbers are designed so the survey-only
 * portion sums to 100 and behavioral (computed) contributes the other
 * 50 — total raw score range 0–150, then scaled to 300–850.
 */
export const FACTORS: FactorDef[] = [
  { id: 'income',     label: 'Monthly income',          maxPoints: 25 },
  { id: 'employment', label: 'Employment stability',    maxPoints: 20 },
  { id: 'debt',       label: 'Existing debt burden',    maxPoints: 20 },
  { id: 'housing',    label: 'Housing situation',       maxPoints: 10 },
  { id: 'dependents', label: 'Number of dependents',    maxPoints: 10 },
  { id: 'education',  label: 'Education',               maxPoints: 5  },
  { id: 'savings',    label: 'Savings habit',           maxPoints: 10 },
  { id: 'on_time',    label: 'On-time payment history', maxPoints: 30 },
  { id: 'defaults',   label: 'Default history',         maxPoints: 20 },
];

export const MAX_RAW_SCORE = FACTORS.reduce((s, f) => s + f.maxPoints, 0);

/** Bundled survey questions — frontend renders these in order. */
export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  {
    kind: 'number',
    id: 'monthly_income',
    label: 'What is your monthly net income (PHP)?',
    help: 'Take-home pay after taxes and standard deductions.',
    min: 0,
    max: 200_000,
    step: 1000,
    factorId: 'income',
  },
  {
    kind: 'choice',
    id: 'employment_status',
    label: 'What best describes your employment?',
    factorId: 'employment',
    options: [
      { label: 'Regular employee (1+ year)', value: 'regular_1y', weight: 1.0 },
      { label: 'Regular employee (<1 year)', value: 'regular_lt1y', weight: 0.7 },
      { label: 'Contractual / project-based', value: 'contractual', weight: 0.5 },
      { label: 'Self-employed / freelance',   value: 'self_employed', weight: 0.55 },
      { label: 'Unemployed / student',        value: 'unemployed', weight: 0.0 },
    ],
  },
  {
    kind: 'number',
    id: 'existing_debt',
    label: 'Total monthly debt payments today (PHP)',
    help: 'Other loans, credit-card minimums, etc. Lower is better.',
    min: 0,
    max: 100_000,
    step: 500,
    factorId: 'debt',
    inverted: true,
  },
  {
    kind: 'choice',
    id: 'housing',
    label: 'Where do you live?',
    factorId: 'housing',
    options: [
      { label: 'Owned (no mortgage)',    value: 'owned',     weight: 1.0 },
      { label: 'Owned (with mortgage)',  value: 'mortgaged', weight: 0.8 },
      { label: 'Renting',                value: 'renting',   weight: 0.5 },
      { label: 'Living with family',     value: 'family',    weight: 0.7 },
    ],
  },
  {
    kind: 'number',
    id: 'dependents',
    label: 'How many dependents do you support financially?',
    min: 0,
    max: 10,
    step: 1,
    factorId: 'dependents',
    inverted: true,
  },
  {
    kind: 'choice',
    id: 'education',
    label: 'Highest education attained',
    factorId: 'education',
    options: [
      { label: 'Postgraduate',    value: 'postgrad',   weight: 1.0 },
      { label: 'College graduate', value: 'college',   weight: 0.85 },
      { label: 'Some college',     value: 'some_college', weight: 0.6 },
      { label: 'High school',      value: 'highschool', weight: 0.45 },
      { label: 'Elementary',       value: 'elementary', weight: 0.3 },
    ],
  },
  {
    kind: 'boolean',
    id: 'savings_habit',
    label: 'Do you set aside money for savings every month?',
    weightWhenTrue: 1.0,
    factorId: 'savings',
  },
];
