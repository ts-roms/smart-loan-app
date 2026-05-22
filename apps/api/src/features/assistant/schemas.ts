import { z } from "zod";

/**
 * Schemas for the assistant feature. Each endpoint takes a small,
 * well-scoped input — we deliberately don't accept free-form prompts
 * from the client. The route layer feeds the LLM structured rows
 * pulled from our own DB so the model can't be steered into PII it
 * doesn't need.
 */

/** POST /assistant/explain-decision */
export const explainSchema = z.object({
  loanId: z.string().uuid(),
});
export type ExplainInput = z.infer<typeof explainSchema>;

/**
 * POST /assistant/draft-demand-letter
 *
 * Stage drives both the system prompt's deadline wording and the
 * audit-log payload. Kept in sync with the DemandLetter.stage enum
 * upstream.
 */
export const draftSchema = z.object({
  loanId: z.string().uuid(),
  stage: z.enum(["FIRST", "FINAL", "ATTORNEY_FIRST", "ATTORNEY_FINAL"]),
});
export type DraftInput = z.infer<typeof draftSchema>;

/** POST /assistant/summarize-account */
export const summarizeSchema = z.object({
  customerId: z.string().uuid(),
});
export type SummarizeInput = z.infer<typeof summarizeSchema>;
