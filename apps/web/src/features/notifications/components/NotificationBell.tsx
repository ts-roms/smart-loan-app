import {
  useMarkNotificationsSeen,
  useMyNotificationState,
  useNotifications,
} from "@loan/api-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from "@loan/ui";
import { Bell, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";

import { notificationLink } from "../links";

/**
 * Top-bar notification bell. Click to open a dropdown with the last 10
 * notifications. A rose badge over the bell shows how many landed in the
 * last 24 hours; rows from that window get a subtle sky tint so the eye
 * snaps to fresh ones.
 *
 * Driven by `/notifications` (all system-wide notifications) — staff are
 * authorized to see them all. The `/notifications` page is the full list.
 *
 * Rows link to whatever they were raised about — the loan, the
 * customer — via the `refType`/`refId` the notification already
 * carries. Reading "Loan disbursed · LN-2026-000006" and then having
 * to go find that loan by hand was the whole complaint.
 */

const EVENT_LABELS: Record<string, string> = {
  LOAN_APPROVED: "Loan approved",
  LOAN_REJECTED: "Loan rejected",
  LOAN_DISBURSED: "Loan disbursed",
  LOAN_APPROVAL_PENDING: "Loan needs approval",
  STATEMENT_READY: "Statement ready",
  PAYMENT_RECEIVED: "Payment received",
  PAYMENT_DUE_SOON: "Payment due soon",
  PAYMENT_OVERDUE: "Payment overdue",
  PROMISE_TO_PAY: "Promise to pay",
  WELCOME: "Welcome",
  TEST: "Test notification",
};

/** Compact relative time formatter — "2m", "3h", "5d". Falls back to date. */
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

export function NotificationBell() {
  const notifs = useNotifications();
  const state = useMyNotificationState();
  const markSeen = useMarkNotificationsSeen();
  const rows = (notifs.data ?? []).slice(0, 10);
  const unseen = state.data?.unseen ?? 0;
  const lastSeenAt = state.data?.lastSeenAt
    ? new Date(state.data.lastSeenAt)
    : null;

  // When the user opens the dropdown, advance their lastSeenNotificationAt
  // cursor so the badge resets. We fire this on the Radix onOpenChange
  // event rather than on every render — that way, viewing the bell once
  // counts as "seen".
  const onOpenChange = (open: boolean) => {
    if (open && unseen > 0 && !markSeen.isPending) {
      markSeen.mutate();
    }
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Notifications"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-fg hover:text-fg hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition"
        >
          <Bell className="h-4 w-4" />
          {unseen > 0 && (
            <span
              className="absolute top-1.5 right-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-fg ring-2 ring-slate-950"
              aria-label={`${unseen} unseen`}
            >
              {unseen > 9 ? "9+" : unseen}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[20rem] max-w-[22rem] p-0"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-default">
          <div className="text-sm font-medium">Notifications</div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            {unseen > 0 ? `${unseen} unseen` : "all caught up"}
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto">
          {notifs.isLoading ? (
            <div className="px-3 py-4 text-xs text-fg-muted">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-fg-muted">
              No notifications yet.
            </div>
          ) : (
            rows.map((n) => {
              // "Unseen" = created strictly after my lastSeenAt cursor.
              // With no cursor yet, treat everything in the visible window
              // as unseen so the user sees the tinted rows on first load.
              const created = new Date(n.createdAt);
              const fresh = lastSeenAt ? created > lastSeenAt : true;
              const to = notificationLink(n);

              const body = (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium text-fg">
                      {EVENT_LABELS[n.event] ?? n.event}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-fg-subtle whitespace-nowrap">
                      {relativeTime(n.createdAt)}
                      {to && <ChevronRight className="h-3 w-3" />}
                    </div>
                  </div>
                  <div className="text-fg-muted truncate mt-0.5">
                    <span className="font-mono text-[10px] uppercase">
                      {n.channel}
                    </span>
                    {" · "}
                    {n.recipient}
                  </div>
                  {n.subject && (
                    <div className="text-fg-muted truncate mt-0.5">
                      {n.subject}
                    </div>
                  )}
                </>
              );

              const rowClass = cn(
                "block px-3 py-2 text-xs border-b border-default last:border-b-0",
                fresh && "bg-sky-500/[0.04]",
              );

              // A notification with nowhere to point stays a plain row —
              // see notificationLink. Wrapping it in a DropdownMenuItem
              // anyway would give it hover and focus styling that
              // promises a navigation it can't perform.
              if (!to) {
                return (
                  <div key={n.id} className={rowClass}>
                    {body}
                  </div>
                );
              }

              return (
                <DropdownMenuItem key={n.id} asChild className="p-0">
                  <Link to={to} className={cn(rowClass, "cursor-pointer")}>
                    {body}
                  </Link>
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <DropdownMenuItem asChild>
          <Link
            to="/notifications"
            className="cursor-pointer justify-center text-info hover:text-info"
          >
            View all notifications
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
