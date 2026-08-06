import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Default surface for the app. Uses the `surface-2` tier (slightly lifted
 * from the page background) so cards feel like they're floating on a
 * plate rather than painted on. An inset 1px top highlight gives the top
 * edge a hint of light — same trick Stripe / Linear use for depth.
 *
 * Pass `variant="elevated"` for hero / KPI cards that need more presence;
 * they switch to surface-3 and pick up a stronger inner highlight + a
 * soft drop shadow.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "elevated" | "ghost";
  /**
   * Decorative glyph bled off the bottom-right corner.
   *
   * Pass a sized, coloured icon — `<Wallet className="h-32 w-32
   * text-primary" />` — and the card supplies the position, the
   * opacity, the clipping and the hover response. Size and hue stay
   * with the caller because those are the two things that differ per
   * tile; everything else is the same everywhere and belongs here.
   *
   * Purely decorative, so it's `aria-hidden` and outside the tab and
   * hit-test order. Never put anything a reader needs in it.
   */
  watermark?: ReactNode;
  /**
   * Lift and deepen on pointer hover.
   *
   * Opt-in rather than automatic, because it changes what a card
   * claims to be. On a stat tile the lift reads as "this is an
   * object", which is what stops a grid of numbers from looking like
   * one ruled table — worth having whether or not the tile is
   * clickable. On a card full of rows it would read as "click me",
   * so don't.
   *
   * Clickability is carried by the cursor, not by the lift: pair this
   * with `cursor-pointer` when the card is actually a link.
   */
  hover?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    { className, variant = "default", watermark, hover, children, ...props },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border",
        /*
         * A hover card animates `transform`, which `transition-colors`
         * doesn't cover — and a `transition` shorthand in the CSS layer
         * loses to the generated utility, so it has to be named here as
         * a utility or the lift silently never animates.
         */
        hover
          ? "card-hover transition-[transform,box-shadow,border-color] duration-200 ease-out"
          : "transition-colors",
        variant === "default" && "bg-surface-2 border-default card-resting",
        variant === "elevated" && "card-elevated",
        variant === "ghost" && "border-transparent bg-transparent",
        /*
         * `isolate` makes the card its own stacking context, which is
         * what lets the watermark sit at `z-index: -1` — above the
         * card's background but under its text. Without it the negative
         * index would drop the glyph behind the card entirely and it
         * would only appear on hover, when the lift's `transform`
         * happens to create the context for it.
         */
        watermark && "relative isolate overflow-hidden",
        className,
      )}
      {...props}
    >
      {watermark && (
        <span className="card-watermark" aria-hidden>
          {watermark}
        </span>
      )}
      {children}
    </div>
  ),
);
Card.displayName = "Card";

export const CardHeader = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1 p-5 pb-3", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

export const CardTitle = forwardRef<
  HTMLHeadingElement,
  HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn("text-sm font-semibold tracking-tight text-fg", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

export const CardDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-xs text-fg-muted", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

export const CardContent = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-5 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

export const CardFooter = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-5 pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";
