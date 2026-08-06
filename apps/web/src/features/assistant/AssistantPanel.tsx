import { useAssistantPing, type AssistantResponse } from "@loan/api-client";
import { Badge, Button, useToast } from "@loan/ui";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

export interface AssistantTask {
  /** Stable id, used as React key. */
  id: string;
  /** Button label, e.g. "Explain decision". */
  label: string;
  /** Optional one-liner explaining what the task does. */
  hint?: string;
  /** Hook trigger — runs the mutation, returns the response. */
  run: () => Promise<AssistantResponse>;
  /**
   * Optional callback fired with the generated text. Lets the parent
   * "insert into letter body", "copy to draft", etc.
   */
  onInsert?: (text: string) => void;
}

export interface AssistantPanelProps {
  /** Pre-built tasks the panel exposes as buttons. */
  tasks: AssistantTask[];
  /** Optional title rendered above the buttons. */
  title?: string;
}

/**
 * Reusable AI assistant card. Each parent (loan detail, customer
 * detail, collections case drawer) hands in the set of tasks that
 * make sense in its context. The panel handles:
 *
 *   - Ping the backend on mount so we know whether Ollama is configured.
 *     If not, render an inline notice instead of the task buttons.
 *   - Running one task at a time (officers don't multi-task on AI).
 *   - Showing the generated text in a copyable / insertable surface.
 *   - Stamping every response with the model name + a clear "always
 *     review before using" disclaimer.
 *
 * The whole feature is opt-in: with no Ollama service running, the
 * mock provider returns a "configure Ollama" message and the panel
 * still works correctly.
 */
export function AssistantPanel({
  tasks,
  title = "AI assistant",
}: AssistantPanelProps) {
  const ping = useAssistantPing();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{
    taskId: string;
    response: AssistantResponse;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refetch ping when the panel becomes visible — useful after the
  // operator pulls a model without restarting the app.
  useEffect(() => {
    void ping.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAvailable = ping.data?.ok ?? false;
  const isMock = ping.data?.provider === "mock";

  const onRun = async (task: AssistantTask) => {
    setBusy(task.id);
    setError(null);
    try {
      const r = await task.run();
      setResult({ taskId: task.id, response: r });
    } catch (err) {
      const msg = (err as Error).message ?? "Assistant failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  const onCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.response.text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Clipboard unavailable — select the text manually");
    }
  };

  const onInsert = () => {
    if (!result) return;
    const task = tasks.find((t) => t.id === result.taskId);
    task?.onInsert?.(result.response.text);
    toast.success("Inserted into draft");
  };

  return (
    <div className="rounded-md border border-info/20 bg-info/[0.04] p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md border border-info/30 bg-info/10 flex items-center justify-center shrink-0">
            <Sparkles className="h-4 w-4 text-info" />
          </div>
          <div>
            <div className="text-sm font-semibold">{title}</div>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
              Local LLM · never sends data off your server
            </div>
          </div>
        </div>
        {ping.data && (
          <Badge
            variant={isAvailable ? "success" : "warning"}
            title={ping.data.message}
          >
            {isAvailable ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <AlertTriangle className="h-3 w-3" />
            )}
            {isMock ? "Mock" : ping.data.model} ·{" "}
            {isAvailable ? "ready" : "not ready"}
          </Badge>
        )}
      </div>

      {/* Status notice when not configured / not ready */}
      {ping.data && !isAvailable && (
        <div className="rounded-md border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning">
          {ping.data.message}
        </div>
      )}

      {/* Task buttons */}
      <div className="flex flex-wrap gap-2">
        {tasks.map((task) => (
          <Button
            key={task.id}
            size="sm"
            variant="outline"
            disabled={busy !== null || !ping.data}
            onClick={() => onRun(task)}
            title={task.hint}
          >
            {busy === task.id ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Thinking…
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                {task.label}
              </>
            )}
          </Button>
        ))}
      </div>

      {/* Result */}
      {result && (
        <ResultSurface
          response={result.response}
          onCopy={onCopy}
          onInsert={
            tasks.find((t) => t.id === result.taskId)?.onInsert
              ? onInsert
              : undefined
          }
          onDismiss={() => setResult(null)}
        />
      )}

      {/* Error */}
      {error && !result && (
        <div className="rounded-md border border-danger/30 bg-danger/10 p-2 text-[11px] text-danger flex items-start gap-2">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <p className="text-[10px] text-fg-subtle">
        Always review and edit AI-generated text before sending or saving. The
        model is a drafting assistant, not a decision-maker.
      </p>
    </div>
  );
}

function ResultSurface({
  response,
  onCopy,
  onInsert,
  onDismiss,
}: {
  response: AssistantResponse;
  onCopy: () => void;
  onInsert?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md border border-default bg-black/30 p-3 space-y-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-fg-subtle">
        <span>Generated</span>
        <div className="flex items-center gap-2">
          <span className="font-mono normal-case text-fg-muted">
            {response.model}
            {response.isMock && " · mock"}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-fg-subtle hover:text-fg"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <Pre>{response.text}</Pre>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCopy}>
          <Copy className="h-3 w-3" />
          Copy
        </Button>
        {onInsert && (
          <Button size="sm" onClick={onInsert}>
            <CheckCircle2 className="h-3 w-3" />
            Insert
          </Button>
        )}
      </div>
    </div>
  );
}

function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="text-xs text-fg whitespace-pre-wrap leading-relaxed font-sans max-h-72 overflow-auto">
      {children}
    </pre>
  );
}
