import type { UserPresence } from "@loan/shared-types";
import { cn } from "@loan/ui";

/**
 * Coarse "how long ago", for the offline label.
 *
 * Deliberately vague past an hour. The heartbeat lands at 30-second
 * granularity and the reader's question is "recently, or not?" — a
 * precise "47 minutes ago" would imply a resolution the underlying
 * timestamp doesn't have, and invites someone to draw conclusions from
 * the difference between 47 and 52.
 */
function lastSeenLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/**
 * Online indicator for a user row.
 *
 * A dot plus a word, never a dot alone. Colour is the fastest signal
 * for most readers and useless for the rest — roughly one man in twelve
 * cannot separate the green from the amber — so the state is always
 * written out as well.
 *
 * "Online" here means "made an authenticated request inside the org's
 * idle window", which is what the underlying data can actually support.
 * It is not "has the app open": someone reading a report without
 * clicking makes no requests, and the shell's own idle timer will sign
 * them out on the same reasoning.
 */
export function PresenceBadge({
  presence,
  lastSeenAt,
  className,
}: {
  presence: UserPresence;
  lastSeenAt: string | null;
  className?: string;
}) {
  const online = presence === "ONLINE";
  const label =
    presence === "ONLINE"
      ? "Online"
      : presence === "NEVER"
        ? "Never signed in"
        : lastSeenAt
          ? lastSeenLabel(lastSeenAt)
          : "Offline";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        online ? "text-success" : "text-fg-subtle",
        className,
      )}
      // The exact timestamp on hover — the coarse label is for scanning,
      // and someone chasing an incident needs the real number.
      title={
        lastSeenAt
          ? `Last seen ${new Date(lastSeenAt).toLocaleString()}`
          : "No authenticated request on record"
      }
    >
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          online ? "bg-success" : "bg-fg-subtle/40",
        )}
      />
      {label}
    </span>
  );
}
