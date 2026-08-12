import { cn } from "@loan/ui";
import type { Wallet } from "lucide-react";

/**
 * The small icon-plus-figure tile the customer panels are built from.
 *
 * Extracted because the exposure panel wanted the same tile the ledger
 * panel already had, and a second copy would have drifted — the two sit
 * one above the other on the customer page, where a tile a pixel
 * different or an accent colour off reads as one of them being broken.
 */
export function StatTile({
  label,
  value,
  icon: Icon,
  accent,
  sub,
}: {
  label: string;
  value: string;
  icon: typeof Wallet;
  accent: "primary" | "success" | "warning" | "danger" | "info" | "muted";
  sub?: string;
}) {
  const accentClass: Record<typeof accent, string> = {
    primary: "text-primary bg-primary-soft",
    success: "text-success bg-success-soft",
    warning: "text-warning bg-warning-soft",
    danger: "text-danger bg-danger-soft",
    info: "text-info bg-info-soft",
    muted: "text-fg-muted bg-surface-3",
  };
  return (
    <div className="rounded-md border border-default bg-surface-2 p-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-7 w-7 rounded-md border border-default flex items-center justify-center shrink-0",
            accentClass[accent],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle truncate">
            {label}
          </div>
          <div className="text-sm font-semibold tabular truncate">{value}</div>
        </div>
      </div>
      {sub && (
        <div className="text-[10px] text-fg-subtle tabular mt-1 truncate">
          {sub}
        </div>
      )}
    </div>
  );
}
