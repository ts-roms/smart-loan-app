/**
 * Local LLM assistant routes. These wrap the LLMProvider with carefully
 * structured prompts for three operator workflows:
 *
 *   POST /assistant/ping              — backend reachability + model status
 *   POST /assistant/explain-decision  — plain-language verdict explanation
 *   POST /assistant/draft-demand-letter — first-pass demand-letter body
 *   POST /assistant/summarize-account — borrower history summary
 *
 * Every prompt template:
 *   - Tells the LLM to write factually, briefly, professionally.
 *   - Marks itself as an "assistant" — the officer reviews + edits.
 *   - Provides structured data, not raw DB rows, so the model can't
 *     wander into PII it doesn't need.
 *
 * Audit log entry per call captures the action, target id, and the
 * model identifier. We DON'T log full prompts or full responses (audit
 * payload size + GDPR caution); just the metadata.
 *
 * Phase 2: per-request prisma via `req.tenantCtx.prisma`. The LLM
 * provider itself is tenant-agnostic (singleton at plugin scope) — it
 * just translates prompts to Ollama. Only the DB reads + audit writes
 * are tenant-scoped.
 */
import { AuditLogRepository, LoanRepository } from "@loan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

// Paths adjusted for the features/assistant/ nesting — config lives two
// folders up at src/config.ts and the LLM provider factory at src/lib/llm.ts.
import { config } from "../../config";
import { createLLMProvider, type LLMProvider } from "../../lib/llm";
import { routeSchema } from "../../lib/openapi";
import {
  completionResponseSchema,
  draftSchema,
  explainSchema,
  pingResponseSchema,
  summarizeSchema,
} from "./schemas";

const TAGS = ["assistant"];

declare module "fastify" {
  interface FastifyRequest {
    assistantCtx?: {
      loans: LoanRepository;
      audit: AuditLogRepository;
    };
  }
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  const llm: LLMProvider = createLLMProvider({
    url: config.ollamaUrl,
    model: config.ollamaModel,
  });

  /*
   * onRequest, not preHandler — routes in this group carry request
   * schemas, and Fastify validates at preValidation, BEFORE preHandler.
   * With `authenticate` at preHandler an unauthenticated caller posting
   * a malformed body got a 400 describing the schema instead of a 401.
   * See decision-rules.routes.ts for the full account.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.assistantCtx = {
      loans: new LoanRepository(prisma),
      audit: new AuditLogRepository(prisma, req.user?.impersonatedBy),
    };
  });

  // AI assistant is an ENTERPRISE-tier feature. License gate applies
  // to every assistant route — including /ping, which the UI uses to
  // decide whether to render the panel. A locked panel will render
  // a "Configure Ollama" hint OR an "Upgrade to ENTERPRISE" hint
  // depending on the 402 kind.
  app.addHook("preHandler", app.requireFeature("intel.ai_assistant"));

  /**
   * Backend health for the UI. The web app calls this once when the
   * AssistantPanel mounts so it can show "model loaded" vs "configure
   * Ollama" instead of waiting for the first generation to fail.
   */
  app.get(
    "/ping",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "Is a model reachable behind this panel. Answers 200 with " +
          "ok:false when it is not — an unreachable backend is a state.",
        tags: TAGS,
        response: pingResponseSchema,
        errors: [401, 402, 403],
      }),
    },
    async () => {
      const status = await llm.ping();
      return {
        provider: llm.name,
        model: config.ollamaModel,
        ...status,
      };
    },
  );

  // ── Explain a loan's decisioning verdict ────────────────────────
  app.post(
    "/explain-decision",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "Plain-language account of why a loan reached its status. " +
          "Draft output — check isMock before showing it to anyone.",
        tags: TAGS,
        body: explainSchema,
        response: completionResponseSchema,
        errors: [400, 401, 402, 403, 404],
      }),
    },
    async (req, reply) => {
      const parsed = explainSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const { loans, audit } = req.assistantCtx!;
      const loan = await loans.findById(parsed.data.loanId);
      if (!loan) return reply.code(404).send({ error: "NotFound" });

      const system = SYSTEM_EXPLAIN_DECISION;
      const user = buildExplainDecisionPrompt(loan);
      const result = await llm.complete({
        system,
        user,
        maxTokens: config.ollamaMaxTokens,
      });

      await audit.record({
        action: "ASSISTANT_EXPLAIN_DECISION",
        actorId: req.user.sub,
        targetType: "LoanApplication",
        targetId: loan.id,
        payload: {
          provider: llm.name,
          model: result.model,
          tokenCount: result.tokenCount,
          isMock: result.isMock,
        },
      });

      return { text: result.text, model: result.model, isMock: result.isMock };
    },
  );

  // ── Draft a demand letter ───────────────────────────────────────
  app.post(
    "/draft-demand-letter",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "First-pass demand-letter body for a loan and stage. Contains " +
          "<PLACEHOLDERS> the officer fills in; never dispatch as-is.",
        tags: TAGS,
        body: draftSchema,
        response: completionResponseSchema,
        errors: [400, 401, 402, 403, 404],
      }),
    },
    async (req, reply) => {
      const parsed = draftSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const { loans, audit } = req.assistantCtx!;
      const loan = await loans.findById(parsed.data.loanId);
      if (!loan) return reply.code(404).send({ error: "NotFound" });

      const system = SYSTEM_DRAFT_DEMAND_LETTER;
      const user = buildDraftDemandLetterPrompt(loan, parsed.data.stage);
      const result = await llm.complete({
        system,
        user,
        maxTokens: 800, // letters need more room than a verdict explanation
      });

      await audit.record({
        action: "ASSISTANT_DRAFT_DEMAND_LETTER",
        actorId: req.user.sub,
        targetType: "LoanApplication",
        targetId: loan.id,
        payload: {
          provider: llm.name,
          model: result.model,
          stage: parsed.data.stage,
          tokenCount: result.tokenCount,
          isMock: result.isMock,
        },
      });

      return { text: result.text, model: result.model, isMock: result.isMock };
    },
  );

  // ── Summarize a customer's account history ─────────────────────
  app.post(
    "/summarize-account",
    {
      preHandler: app.requirePermission("loans.read"),
      schema: routeSchema({
        summary:
          "Narrative summary of a borrower's history over their ten most " +
          "recent loans. Draft output — check isMock.",
        tags: TAGS,
        body: summarizeSchema,
        response: completionResponseSchema,
        errors: [400, 401, 402, 403, 404],
      }),
    },
    async (req, reply) => {
      const parsed = summarizeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const { audit } = req.assistantCtx!;
      const customer = await req.tenantCtx.prisma.customer.findUnique({
        where: { id: parsed.data.customerId },
        include: {
          loanApplications: {
            orderBy: { submittedAt: "desc" },
            take: 10,
            select: {
              id: true,
              number: true,
              productCode: true,
              principal: true,
              status: true,
              submittedAt: true,
              closedAt: true,
            },
          },
        },
      });
      if (!customer) return reply.code(404).send({ error: "NotFound" });

      const system = SYSTEM_SUMMARIZE_ACCOUNT;
      const user = buildSummarizeAccountPrompt({
        // Repack the Prisma row into the shape our prompt builder expects.
        ...customer,
        loans: customer.loanApplications,
      });
      const result = await llm.complete({
        system,
        user,
        maxTokens: config.ollamaMaxTokens,
      });

      await audit.record({
        action: "ASSISTANT_SUMMARIZE_ACCOUNT",
        actorId: req.user.sub,
        targetType: "Customer",
        targetId: customer.id,
        payload: {
          provider: llm.name,
          model: result.model,
          tokenCount: result.tokenCount,
          isMock: result.isMock,
        },
      });

      return { text: result.text, model: result.model, isMock: result.isMock };
    },
  );
}

// ─────────────────────────────────────────────────────────────────
// Prompt templates
// ─────────────────────────────────────────────────────────────────

/**
 * Shared style guide — included in every system prompt so behavior
 * stays consistent across endpoints. Refines the LLM toward
 * factual, regulator-friendly tone.
 */
const SHARED_STYLE = `
You are a loan officer assistant in a Philippine cooperative lending system. Rules:
- Write professionally and concisely. No marketing language.
- Stick to the data provided. If a fact isn't in the input, say "not provided" rather than inferring.
- The officer always reviews and edits your output before using it. Don't say "I" — you're drafting on the officer's behalf.
- Currency is Philippine pesos (₱). Dates are ISO YYYY-MM-DD.
`.trim();

const SYSTEM_EXPLAIN_DECISION =
  SHARED_STYLE +
  `

Task: Explain a loan-decisioning verdict to a fellow officer in 2-3 sentences. Cover:
  1. The verdict (approve, reject, manual review) and the matched rule.
  2. The key context factors that drove it (credit score, income, KYC, prior loans).
  3. What's expected next (officer review, missing docs, board approval).
Plain prose. No bullet lists. No headers.`;

const SYSTEM_DRAFT_DEMAND_LETTER =
  SHARED_STYLE +
  `

Task: Draft a formal demand letter for an overdue Philippine cooperative loan. Format:
  - Address line: "To: <borrower full name>"
  - Subject line referencing the loan number and stage.
  - Opening paragraph stating the outstanding balance and days overdue.
  - Middle paragraph quoting the loan agreement clause being invoked.
  - Closing paragraph stating the deadline (7 days for FIRST, 3 days for FINAL,
    "before legal action" for ATTORNEY variants) and consequences.
  - Sign-off: "<Officer name placeholder>, <Cooperative name placeholder>"
Keep total length under 250 words. Don't include actual lawyer signatures or court references.`;

const SYSTEM_SUMMARIZE_ACCOUNT =
  SHARED_STYLE +
  `

Task: Summarize a borrower's account history in 3-4 sentences. Cover:
  1. How long they've been a customer and total loan count.
  2. Their payment behavior (on-time vs. overdue, any defaults).
  3. Any open loans (count + total outstanding).
  4. A one-sentence "good standing / watch / concern" verdict.
Plain prose. No bullet lists.`;

// ─────────────────────────────────────────────────────────────────
// Prompt builders (typed against the repo return shapes)
// ─────────────────────────────────────────────────────────────────

interface LoanLike {
  id: string;
  number: string;
  productCode: string;
  principal: number | string | { toString(): string };
  termMonths: number;
  annualInterestRate: number | string | { toString(): string };
  status: string;
  submittedAt: Date | string;
  decisionReason?: string | null;
  creditScoreAtApply?: number | null;
  tierAtApply?: string | null;
  applicantName?: string;
}

function buildExplainDecisionPrompt(loan: LoanLike): string {
  return `Loan: ${loan.number}
Product: ${loan.productCode}
Principal: ₱${Number(loan.principal).toLocaleString()}
Term: ${loan.termMonths} months
APR: ${(Number(loan.annualInterestRate) * 100).toFixed(2)}%
Current status: ${loan.status}
Credit score at apply: ${loan.creditScoreAtApply ?? "not provided"}
Credit tier at apply: ${loan.tierAtApply ?? "not provided"}
Decision reason captured: ${loan.decisionReason ?? "not provided"}

Explain why this loan reached its current status. Keep it factual and short.`;
}

function buildDraftDemandLetterPrompt(loan: LoanLike, stage: string): string {
  const stageLabel =
    {
      FIRST: "First demand notice",
      FINAL: "Final demand notice",
      ATTORNEY_FIRST: "Attorney's first demand notice",
      ATTORNEY_FINAL: "Attorney's final demand notice",
    }[stage] ?? stage;
  return `Stage: ${stageLabel}
Loan number: ${loan.number}
Product: ${loan.productCode}
Original principal: ₱${Number(loan.principal).toLocaleString()}
Term: ${loan.termMonths} months
APR: ${(Number(loan.annualInterestRate) * 100).toFixed(2)}%
Loan status: ${loan.status}

Draft the demand letter body. Use placeholders like <OUTSTANDING_BALANCE>,
<DAYS_OVERDUE>, <BORROWER_NAME>, <OFFICER_NAME>, <COOPERATIVE_NAME>
where exact values aren't provided — the officer fills them in before
dispatch.`;
}

interface CustomerWithLoans {
  id: string;
  firstName: string;
  lastName: string;
  kycStatus: string;
  monthlyIncome: number | string | { toString(): string };
  createdAt: Date | string;
  loans: Array<{
    id: string;
    number: string;
    productCode: string;
    principal: number | string | { toString(): string };
    status: string;
    submittedAt: Date | string;
    closedAt: Date | string | null;
  }>;
}

function buildSummarizeAccountPrompt(c: CustomerWithLoans): string {
  const loansLines = c.loans.length
    ? c.loans
        .map((l) => {
          const submitted = new Date(l.submittedAt).toISOString().slice(0, 10);
          const closed = l.closedAt
            ? new Date(l.closedAt).toISOString().slice(0, 10)
            : "—";
          return `  ${l.number} · ${l.productCode} · ₱${Number(l.principal).toLocaleString()} · ${l.status} · submitted ${submitted} · closed ${closed}`;
        })
        .join("\n")
    : "  (no loans on file)";
  const memberSince = new Date(c.createdAt).toISOString().slice(0, 10);
  return `Customer: ${c.firstName} ${c.lastName}
KYC status: ${c.kycStatus}
Monthly income: ₱${Number(c.monthlyIncome).toLocaleString()}
Member since: ${memberSince}

Loan history (newest first):
${loansLines}

Summarize this account.`;
}
