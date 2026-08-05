import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { cn } from "../lib/cn";

/**
 * Page control for the list tables.
 *
 * Deliberately dumb: it takes the numbers the server already returned and
 * reports which page the user asked for. It doesn't fetch, doesn't own
 * the page state, and doesn't clamp — the owner does that, because it's
 * the owner that also has to reset to page 1 when a filter changes.
 *
 * The range readout ("Showing 26–50 of 130") is the part that earns its
 * place: without it, a table capped at 25 rows silently looks like the
 * whole result set.
 */
export interface PaginationProps {
  /** 1-indexed page currently shown. */
  page: number;
  /** From the server. At least 1 even when nothing matched. */
  totalPages: number;
  /** Total rows matching the filter, across all pages. */
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /**
   * Singular noun for the readout — "loan" renders as "130 loans".
   * Plural is the noun + "s"; pass a `pluralNoun` when that's wrong.
   */
  noun?: string;
  pluralNoun?: string;
  /** Dim the controls while a page is in flight. */
  busy?: boolean;
  className?: string;
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  noun = "row",
  pluralNoun,
  busy = false,
  className,
}: PaginationProps) {
  const label = total === 1 ? noun : (pluralNoun ?? `${noun}s`);

  // Derived from the page actually served, so it stays honest if the
  // server clamped what was asked for.
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 pt-1",
        busy && "opacity-60",
        className,
      )}
    >
      <span className="text-xs text-fg-muted" aria-live="polite">
        {total === 0
          ? `No ${label}`
          : `Showing ${first}–${last} of ${total} ${label}`}
      </span>

      {/* Hidden entirely on a single page — a control that can't do
          anything is noise, and its presence implies there's more. */}
      {totalPages > 1 && (
        <nav className="flex items-center gap-1" aria-label="Pagination">
          <PageButton
            label="First page"
            disabled={atStart}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </PageButton>
          <PageButton
            label="Previous page"
            disabled={atStart}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </PageButton>
          <span className="px-2 text-xs text-fg-muted tabular-nums">
            Page {page} of {totalPages}
          </span>
          <PageButton
            label="Next page"
            disabled={atEnd}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </PageButton>
          <PageButton
            label="Last page"
            disabled={atEnd}
            onClick={() => onPageChange(totalPages)}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </PageButton>
        </nav>
      )}
    </div>
  );
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-md border border-default bg-surface-2 p-1.5",
        "hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}
