/**
 * Local LLM provider. The whole assistant feature runs through this
 * abstraction so we can swap implementations without touching routes:
 *
 *   - MockProvider  — boots without an external service; returns a
 *                     deterministic canned response so the UI keeps
 *                     working for development + smoke tests.
 *   - OllamaProvider — talks to an Ollama server (local or networked).
 *                     Selected by setting OLLAMA_URL in env.
 *
 * Why local-only: financial-services regulation. We never want
 * borrower names / loan amounts to leave the operator's infrastructure,
 * and "we self-host the LLM" is a real differentiator vs. competitors
 * who call OpenAI behind the scenes.
 */

export interface LLMCompletionInput {
  /** System-message; the assistant's persona + ground rules. */
  system: string;
  /** User-message; the actual question + structured data. */
  user: string;
  /** Soft ceiling on output length. Provider may exceed slightly. */
  maxTokens?: number;
}

export interface LLMCompletionResult {
  text: string;
  /** Tokens generated. Null for providers that don't surface it. */
  tokenCount: number | null;
  /** Model identifier — useful for audit + observability. */
  model: string;
  /** True when the response is from the mock provider (no real LLM). */
  isMock: boolean;
}

export interface LLMProvider {
  readonly name: string;
  /** Quick "is the backend reachable" check; doesn't generate text. */
  ping(): Promise<{ ok: boolean; message: string }>;
  complete(input: LLMCompletionInput): Promise<LLMCompletionResult>;
}

// ─────────────────────────────────────────────────────────────────
// Mock implementation
// ─────────────────────────────────────────────────────────────────

class MockProvider implements LLMProvider {
  readonly name = "mock";

  async ping(): Promise<{ ok: boolean; message: string }> {
    return {
      ok: true,
      message: "Mock provider — set OLLAMA_URL to enable real AI responses.",
    };
  }

  async complete(): Promise<LLMCompletionResult> {
    return {
      text:
        "⚠️ AI assistant is not configured. To enable real responses, start the Ollama service:\n\n" +
        "  docker compose --profile full --profile ai up -d --build\n\n" +
        "Then pull a model (one-time):\n\n" +
        "  docker compose --profile ai exec ollama ollama pull phi3:mini\n\n" +
        "Set OLLAMA_URL=http://ollama:11434 in the api environment and restart the api container.",
      tokenCount: null,
      model: "mock",
      isMock: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Ollama implementation
// ─────────────────────────────────────────────────────────────────

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
  eval_count?: number;
  model: string;
}

class OllamaProvider implements LLMProvider {
  readonly name = "ollama";

  constructor(
    private readonly url: string,
    private readonly model: string,
  ) {}

  async ping(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`${this.url}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        return { ok: false, message: `Ollama responded ${res.status}` };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const installed = data.models?.map((m) => m.name) ?? [];
      const ready = installed.some(
        (n) => n === this.model || n.startsWith(`${this.model}:`),
      );
      return {
        ok: ready,
        message: ready
          ? `${this.model} is loaded.`
          : `Ollama is up but ${this.model} isn't pulled yet. Run:\n  ollama pull ${this.model}`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `Ollama unreachable at ${this.url}: ${(err as Error).message}`,
      };
    }
  }

  async complete(input: LLMCompletionInput): Promise<LLMCompletionResult> {
    // Use the /api/chat endpoint (system + user message slots) over
    // /api/generate. Keeps prompt-engineering closer to the OpenAI
    // shape so future migrations are easier. stream:false because we
    // return a single JSON payload to the web client; SSE streaming
    // can come later.
    const res = await fetch(`${this.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        options: {
          num_predict: input.maxTokens ?? 512,
          // Low temperature: officers want predictable, factual
          // output for compliance work. Creative writing isn't the
          // goal here.
          temperature: 0.3,
        },
      }),
      // 60s ceiling — phi3:mini on CPU can take 10-30s per response,
      // and llama3.1:8b similar. We don't want indefinite hangs.
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as OllamaChatResponse;
    return {
      text: data.message?.content?.trim() ?? "",
      tokenCount: data.eval_count ?? null,
      model: data.model ?? this.model,
      isMock: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────

/**
 * Build the provider once at boot. The mock is selected when
 * OLLAMA_URL is empty, which is the default — assistant routes still
 * work without the optional service.
 */
export function createLLMProvider(opts: {
  url?: string;
  model?: string;
}): LLMProvider {
  if (!opts.url) return new MockProvider();
  return new OllamaProvider(opts.url, opts.model ?? "phi3:mini");
}
