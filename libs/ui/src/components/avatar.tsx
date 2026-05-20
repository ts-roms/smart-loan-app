import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

/**
 * Avatar — initials in a colored circle. The background hue is derived
 * deterministically from the name so the same user always gets the same
 * color across sessions. Pass an `imageUrl` to render a photo instead.
 */
export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  /** Optional image (e.g. customer selfie URL). Falls back to initials on error. */
  imageUrl?: string | null;
  /** Tailwind size class set — defaults to `h-9 w-9 text-sm`. */
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps['size']>, string> = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-9 w-9 text-sm',
  lg: 'h-14 w-14 text-lg',
};

// Six soft accent backgrounds — enough variety for a small team without
// risking unreadable contrast on text.
const PALETTE = [
  'bg-sky-500/30 text-sky-100 ring-sky-400/40',
  'bg-emerald-500/30 text-emerald-100 ring-emerald-400/40',
  'bg-violet-500/30 text-violet-100 ring-violet-400/40',
  'bg-amber-500/30 text-amber-100 ring-amber-400/40',
  'bg-rose-500/30 text-rose-100 ring-rose-400/40',
  'bg-cyan-500/30 text-cyan-100 ring-cyan-400/40',
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function paletteFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export const Avatar = forwardRef<HTMLDivElement, AvatarProps>(
  ({ name, imageUrl, size = 'md', className, ...props }, ref) => {
    const initials = initialsOf(name);
    const palette = paletteFor(name);
    return (
      <div
        ref={ref}
        title={name}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-inset',
          SIZE_CLASSES[size],
          imageUrl ? 'bg-transparent ring-white/15' : palette,
          className,
        )}
        {...props}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={name}
            className="h-full w-full rounded-full object-cover"
            onError={(e) => {
              // If the image breaks, hide it and fall back to initials.
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          initials
        )}
      </div>
    );
  },
);
Avatar.displayName = 'Avatar';
