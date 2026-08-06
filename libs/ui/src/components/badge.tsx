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
        tierA: "border-transparent bg-success/15 text-success",
        tierB: "border-transparent bg-info/15 text-info",
        tierC: "border-transparent bg-warning/15 text-warning",
        tierD: "border-transparent bg-orange-500/15 text-warning",
        tierF: "border-transparent bg-danger/15 text-danger",
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
