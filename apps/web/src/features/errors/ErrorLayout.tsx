import { cn } from "@loan/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared frame for 404 / 500 / crashed-render.
 *
 * Two shapes, because the references are two shapes and the difference
 * carries meaning:
 *
 *   "cover" — brand band across the top with a curve cutting into it,
 *     and the mark straddling the seam. Used for 404. The banner says
 *     "you're still in the app, this is a normal place to end up".
 *
 *   "plain" — nothing but the plate, the numeral, and the mark sitting
 *     on it. Used for 500 and for a crashed render, where dressing the
 *     page up would be at odds with what it has to say.
 *
 * Everything is drawn: the band is the brand gradient, the curve is an
 * inline path, the mark is an icon in a ring. No image asset, so
 * there's nothing to 404 on the 404 page — not a joke, it's the most
 * common way these pages break.
 *
 * Nothing here may touch a React context. `AppErrorBoundary` sits above
 * every provider, so a hook reading the query client or the router
 * would throw during the render that is supposed to BE the recovery.
 * That's why `footer` is a prop rather than a `useBranding()` call: the
 * routed pages can pass branding, the crash page can't.
 */
export function ErrorLayout({
  variant = "plain",
  code,
  icon: Icon,
  title,
  message,
  actions,
  details,
  footer,
  tone = "neutral",
}: {
  variant?: "cover" | "plain";
  /** Big decorative numeral. Omit where there's no HTTP status. */
  code?: string;
  icon: LucideIcon;
  title: string;
  message: ReactNode;
  actions: ReactNode;
  /** Diagnostics — small, under a divider, only when present. */
  details?: ReactNode;
  footer?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  const accentBg = tone === "danger" ? "bg-danger-soft" : "bg-primary-soft";
  const accentInk = tone === "danger" ? "text-danger" : "text-primary";

  return (
    <div className="flex min-h-screen flex-col bg-surface-1">
      {variant === "cover" && (
        <div className="auth-backdrop relative h-[30vh] min-h-[180px] shrink-0">
          {/*
            The curve, filled with the page's OWN surface so it reads as
            the plate rising into the band rather than as a shape drawn
            on top of it — which is what stops it looking like a sticker
            laid over the gradient.

            `preserveAspectRatio="none"` lets it stretch to any width
            without the arc steepening on wide screens; the height is
            pinned in CSS instead.
          */}
          <svg
            aria-hidden
            viewBox="0 0 1440 100"
            preserveAspectRatio="none"
            className="absolute inset-x-0 bottom-0 h-[70px] w-full"
          >
            <path
              d="M0,18 C420,96 1020,96 1440,18 L1440,100 L0,100 Z"
              fill="hsl(var(--surface-1))"
            />
          </svg>
        </div>
      )}

      <div
        className={cn(
          "flex flex-1 flex-col items-center px-4 text-center",
          // Cover pulls the mark up over the seam by exactly half its
          // own height (h-28 → -mt-14), so it stays centred on the
          // boundary whatever height the band resolves to. Plain has no
          // seam, so it just centres in the remaining space.
          variant === "cover" ? "pb-8 pt-0" : "justify-center py-12",
        )}
      >
        {variant === "cover" ? (
          <>
            <div
              className={cn(
                "relative z-10 -mt-14 grid h-28 w-28 place-items-center rounded-full border-4 border-surface-1 shadow-lg",
                accentBg,
              )}
            >
              <Icon aria-hidden className={cn("h-12 w-12", accentInk)} />
            </div>
            {code && (
              <div
                aria-hidden
                // Subtle rather than full-strength ink. It's the
                // largest thing on the page and would otherwise out-shout
                // the heading that actually carries the message.
                className="mt-4 select-none text-[76px] font-bold leading-none tracking-tighter tabular text-foreground-subtle sm:text-[104px]"
              >
                {code}
              </div>
            )}
          </>
        ) : (
          /*
           * Plain stacks the mark ON the numeral rather than above it.
           * The numeral is a muted grey and the mark carries the only
           * colour, so the eye lands on the mark first and reads the
           * number as the backdrop it is.
           */
          code && (
            <div
              aria-hidden
              className="relative inline-grid place-items-center"
            >
              {/*
                `text-foreground-subtle/30`, NOT `text-fg-subtle/30`.
                The short `fg-*` names are hand-written classes in
                globals.css, so Tailwind can't hang an opacity modifier
                off them — it generates nothing and the text silently
                falls back to inherited full-strength ink, which is what
                this line did on the first pass. The long name is a real
                token carrying `<alpha-value>`, so the modifier works.
              */}
              <span className="select-none text-[110px] font-bold leading-none tracking-tighter tabular text-foreground-subtle/70 sm:text-[150px]">
                {code}
              </span>
              <div
                className={cn(
                  "absolute grid h-24 w-24 place-items-center rounded-full shadow-lg ring-8 ring-surface-1",
                  accentBg,
                )}
              >
                <Icon className={cn("h-10 w-10", accentInk)} />
              </div>
            </div>
          )
        )}

        {/* No numeral at all (a crashed render) — the mark still needs
            to be somewhere, and it becomes the whole illustration. */}
        {variant === "plain" && !code && (
          <div
            className={cn(
              "grid h-24 w-24 place-items-center rounded-full shadow-lg",
              accentBg,
            )}
          >
            <Icon aria-hidden className={cn("h-10 w-10", accentInk)} />
          </div>
        )}

        <div className="w-full max-w-lg">
          <h1
            className={cn(
              "mt-5 font-semibold text-fg",
              // Cover shouts, plain speaks. Follows the two references,
              // and it fits: a 404 is a signpost, a 500 is an apology.
              variant === "cover"
                ? "text-lg uppercase tracking-[0.06em] sm:text-xl"
                : "text-xl tracking-tight",
            )}
          >
            {title}
          </h1>
          <div className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-fg-muted">
            {message}
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            {actions}
          </div>

          {details && (
            <div className="mt-7 border-t border-default pt-4 text-left">
              {details}
            </div>
          )}
        </div>
      </div>

      {footer && (
        <div className="pb-6 text-center text-xs text-fg-subtle">{footer}</div>
      )}
    </div>
  );
}
