import {
  useLoanMessages,
  useMarkLoanMessageRead,
  useSendLoanMessage,
} from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  cn,
  useToast,
} from "@loan/ui";
import { MessageSquare, Send } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useAuth } from "../../../providers/auth";

/**
 * In-loan messaging thread shared by the officer's LoanDetail and the
 * borrower's PortalLoanDetail. Each side sees the same conversation
 * keyed off the loan id.
 *
 *   - Polls every 15s (handled by the query hook) so new messages from
 *     the other party arrive without a manual refresh.
 *   - Marks the other side's unread messages as read on mount.
 *   - The composer is a single-row textarea; Enter sends, Shift+Enter newlines.
 */
export function LoanMessagePanel({
  loanId,
  /** Caller-side hint: which role the *current* user is. Used for alignment + labels. */
  perspective,
}: {
  loanId: string;
  perspective: "OFFICER" | "BORROWER";
}) {
  const { user } = useAuth();
  const messages = useLoanMessages(loanId);
  const send = useSendLoanMessage();
  const markRead = useMarkLoanMessageRead();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the latest message whenever the thread grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.data?.length]);

  // Mark the other party's unread messages as read on visit.
  useEffect(() => {
    if (!messages.data) return;
    const unread = messages.data.filter(
      (m) => m.readAt === null && m.authorRole !== perspective,
    );
    for (const m of unread) {
      markRead.mutate({ loanId, messageId: m.id });
    }
    // We deliberately don't depend on `markRead` to avoid re-firing — the
    // server-side write is idempotent enough that occasional duplicates
    // are fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.data?.length, loanId, perspective]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    try {
      await send.mutateAsync({ loanId, body: trimmed });
      setDraft("");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to send");
    }
  };

  const rows = messages.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquare className="h-4 w-4 text-info" />
          Messages
          {rows.length > 0 && (
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle ml-1">
              {rows.length} message{rows.length === 1 ? "" : "s"}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={scrollRef}
          className="max-h-72 overflow-y-auto space-y-2 rounded-md border border-default bg-surface-2 p-3"
        >
          {messages.isLoading ? (
            <p className="text-xs text-fg-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-fg-muted text-center py-4">
              No messages yet. Start the conversation —
              {perspective === "OFFICER"
                ? " the borrower will see it in their portal."
                : " your loan officer will get notified."}
            </p>
          ) : (
            rows.map((m) => {
              const mine = m.authorRole === perspective;
              return (
                <div
                  key={m.id}
                  className={cn("flex", mine ? "justify-end" : "justify-start")}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-lg px-3 py-2 text-xs",
                      mine
                        ? "bg-sky-500/15 text-fg border border-sky-400/30"
                        : "bg-surface-3 text-fg border border-default",
                    )}
                  >
                    <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-0.5">
                      {m.authorRole === "OFFICER" ? "Officer" : "Borrower"} ·{" "}
                      {relativeTime(m.createdAt)}
                    </div>
                    <div className="whitespace-pre-wrap break-words">
                      {m.body}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter for newline.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSubmit(e);
              }
            }}
            rows={2}
            maxLength={2000}
            placeholder={`Message as ${user?.name ?? perspective.toLowerCase()}…`}
            className="flex-1 resize-none rounded-md border border-default bg-surface-2 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400/40"
          />
          <Button
            type="submit"
            disabled={send.isPending || draft.trim().length === 0}
          >
            <Send className="h-3 w-3" />
            Send
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
