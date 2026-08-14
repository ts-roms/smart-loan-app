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

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * name what is CONTRACTUAL and undeclared fields pass through (see
 * lib/openapi.ts). No money and no database rows leave this feature —
 * every response is generated text plus provenance — so neither the
 * Decimal rule nor the row-shape question arises.
 */

/**
 * GET /assistant/ping — is there a model behind this panel.
 *
 * The UI calls it once when the assistant panel mounts so it can render
 * "model loaded" or "configure Ollama" instead of finding out when the
 * first generation fails. Note `ok: false` still comes back as a 200:
 * an unreachable Ollama is a reportable state, not a request error, and
 * the message says which state it is.
 */
export const pingResponseSchema = z.object({
  /** "mock" or "ollama". */
  provider: z.string(),
  /** The configured model id, whether or not it is actually installed. */
  model: z.string(),
  /** False when the backend is unreachable or the model is not pulled. */
  ok: z.boolean(),
  /** Human-readable status — what to fix, when there is something. */
  message: z.string(),
});

/**
 * The shape all three generation endpoints answer.
 *
 * `isMock` is the load-bearing field and the reason this is one schema
 * rather than three: when Ollama is not configured the provider does
 * not fail, it returns setup instructions AS the completion text. A
 * client that renders `text` without checking `isMock` will show a
 * borrower-facing demand letter that is actually a note about
 * installing Ollama. The flag is how a caller tells generated prose
 * from a stand-in.
 *
 * `model` is what actually served the request, which is not necessarily
 * the configured model — compare against ping's `model` to spot a
 * fallback.
 */
export const completionResponseSchema = z.object({
  /** The generated text. Draft output — the officer reviews and edits. */
  text: z.string(),
  /** The model that served this completion. "mock" when unconfigured. */
  model: z.string(),
  /** True when `text` is a stand-in, not a real generation. Check it. */
  isMock: z.boolean(),
});
