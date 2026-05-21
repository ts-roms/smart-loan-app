import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/**
 * Status pill. Variants use the semantic palette (--success / --warning /
 * --danger / --info) so a theme tweak applies everywhere. The `tier*`
 * variants for credit grades stay hue-mapped because tier letters carry
 * their own colour expectations (A green, F red).
 */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition",
  {
    variants: {
      variant: {
        default: "border-default bg-info-soft text-info",
        success: "border-default bg-success-soft text-success",
        warning: "border-default bg-warning-soft text-warning",
        danger: "border-default bg-danger-soft text-danger",
        info: "border-default bg-info-soft text-info",
        muted: "border-default bg-surface-3 text-fg-muted",
        tierA: "border-transparent bg-emerald-500/15 text-emerald-200",
        tierB: "border-transparent bg-sky-500/15 text-sky-200",
        tierC: "border-transparent bg-amber-500/15 text-amber-200",
        tierD: "border-transparent bg-orange-500/15 text-orange-200",
        tierF: "border-transparent bg-rose-500/15 text-rose-200",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
