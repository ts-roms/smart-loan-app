import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-sky-500/15 text-sky-200',
        success: 'border-transparent bg-emerald-500/15 text-emerald-200',
        warning: 'border-transparent bg-amber-500/15 text-amber-200',
        danger: 'border-transparent bg-rose-500/15 text-rose-200',
        muted: 'border-white/10 bg-white/[0.04] text-white/65',
        tierA: 'border-transparent bg-emerald-500/20 text-emerald-200',
        tierB: 'border-transparent bg-sky-500/20 text-sky-200',
        tierC: 'border-transparent bg-amber-500/20 text-amber-200',
        tierD: 'border-transparent bg-orange-500/20 text-orange-200',
        tierF: 'border-transparent bg-rose-500/20 text-rose-200',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
