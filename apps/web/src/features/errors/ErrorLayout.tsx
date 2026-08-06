import { cn } from "@loan/ui";
import type { ReactNode } from "react";

/**
 * Shared frame for 404 / 500 / crashed-render.
 *
 * One layout for all three because they are the same moment from the
 * reader's side: something they expected isn't there, and they need to
 * know whether it's their fault, whether it's temporary, and what to
 * press. Only the answers differ, so only the answers are props.
 *
 * The status number is decorative and marked `aria-hidden` — it's set
 * huge because it's the fastest way for a developer to recognise the
 * page, but a screen reader announcing "404" before the sentence that
 * explains it is noise. The heading carries the meaning.
 */
export function ErrorLayout({
  code,
  title,
  message,
  actions,
  details,
  tone = "neutral",
}: {
  /** Big decorative number. Omit for pages that aren't an HTTP status. */
  code?: string;
  title: string;
  message: ReactNode;
  actions: ReactNode;
  /** Diagnostics — rendered small, under a divider, only when present. */
  details?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-surface-1 px-4 py-12">
      {/*
        Cover pattern. `text-fg` gives the dots the theme's own ink, so
        they're dark-on-light and light-on-dark without a second rule.
        Decorative, so it takes no clicks and never reaches the a11y
        tree — see .bg-overlay-pattern.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-overlay-pattern text-fg"
      />

      <div className="relative w-full max-w-md text-center">
        {code && (
          <div
            aria-hidden
            className={cn(
              "select-none text-[92px] font-bold leading-none tracking-tighter tabular sm:text-[120px]",
              tone === "danger" ? "text-danger/25" : "text-primary/25",
            )}
          >
            {code}
          </div>
        )}

        <h1 className="mt-2 text-xl font-semibold tracking-tight text-fg">
          {title}
        </h1>
        <div className="mt-2 text-sm leading-relaxed text-fg-muted">
          {message}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>

        {details && (
          <div className="mt-8 border-t border-default pt-4 text-left">
            {details}
          </div>
        )}
      </div>
    </div>
  );
}
