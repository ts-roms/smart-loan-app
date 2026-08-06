import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      /*
       * Every variant reads from theme tokens. They used to be
       * hard-coded `sky-500` / `rose-500`, which meant the primary
       * action colour was whatever Tailwind's default blue is no
       * matter what the theme said — re-theming the app never reached
       * its buttons.
       *
       * Solid variants share one shape: token background, token
       * foreground, a resting shadow, and a hover that darkens rather
       * than changing hue. Outline and ghost carry no fill so they
       * recede next to whichever solid sits beside them.
       */
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:opacity-90",
        // Velzon's btn-success — the teal. Its own foreground token
        // because the colour lifts on dark, where a white label would
        // drop to ~1.9:1.
        success:
          "bg-success text-success-foreground shadow-sm hover:opacity-90",
        destructive: "bg-danger text-white shadow-sm hover:opacity-90",
        warning: "bg-warning text-white shadow-sm hover:opacity-90",
        info: "bg-info text-white shadow-sm hover:opacity-90",
        outline: "border border-default bg-surface-2 hover:bg-hover",
        ghost: "hover:bg-hover",
        secondary: "bg-surface-3 hover:bg-hover",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends
    ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * In-flight. Shows a spinner and blocks further clicks.
   *
   * This exists because the app had ~126 hand-rolled versions of it,
   * swapping the label for one of a dozen different verbs — "Saving…",
   * "Posting…", "Accruing…", "Writing off…". None of them showed
   * motion, so a slow request looked like a button that had simply
   * stopped working, and no two screens agreed on the wording.
   *
   * The label is KEPT rather than replaced. Swapping the text moves
   * the button's width mid-click and costs the reader the one piece of
   * information they still want — what they just asked for. The
   * spinner carries the progress; the words stay put.
   */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    // `asChild` renders someone else's element (usually a Link), and
    // injecting a sibling spinner would break Slot's single-child
    // contract. A link isn't a pending action anyway.
    const showSpinner = loading && !asChild;
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {showSpinner ? (
          <>
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";
