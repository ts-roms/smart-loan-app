import { cn } from "../lib/cn";

export function SkeletonLine({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-3 w-full rounded bg-gradient-to-r from-white/[0.04] via-white/[0.10] to-white/[0.04] animate-pulse",
        className,
      )}
    />
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-white/10 bg-white/[0.03] p-4 space-y-3 animate-pulse",
        className,
      )}
    >
      <SkeletonLine className="w-1/3" />
      <SkeletonLine className="w-2/3" />
      <SkeletonLine className="w-1/2" />
    </div>
  );
}
