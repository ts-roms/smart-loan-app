import { z } from "zod";

/**
 * Survey submission shape. `answers` is a free-form key→value map
 * keyed by question id — the questionnaire structure is owned by
 * `@loan/credit-scoring` and the renderer pulls it from
 * `GET /scoring/survey/questions`.
 */
export const submitSurveySchema = z.object({
  customerId: z.string().uuid(),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type SubmitSurveyInput = z.infer<typeof submitSurveySchema>;

/** `?score=720` on the tier convenience endpoint. */
export const tierQuerySchema = z.object({
  score: z.coerce.number().finite(),
});
export type TierQuery = z.infer<typeof tierQuerySchema>;
