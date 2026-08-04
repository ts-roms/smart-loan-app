import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

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
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASSES: Record<NonNullable<AvatarProps["size"]>, string> = {
  sm: "h-7 w-7 text-[10px]",
  md: "h-9 w-9 text-sm",
  lg: "h-14 w-14 text-lg",
};

/*
 * Six accent fills — enough variety for a small team.
 *
 * Saturated fills with white initials, rather than the old
 * 30%-tint-plus-pale-text pairing. A 30% tint reads as a dark disc on a
 * dark page but as a pale wash on a light one, where near-white
 * initials measured 1.31:1 — invisible. A solid fill carries white
 * text against either background, so the avatar looks the same in both
 * themes instead of needing two palettes.
 *
 * The shade is per-hue, not a uniform step: white on Tailwind's 600
 * level ranges from 3.19:1 (amber) to 5.7:1 (violet), because those
 * shades are picked to look evenly saturated, not evenly bright. Sky,
 * emerald and amber need 700 to clear AA; violet and rose don't.
 * Measured, not eyeballed — amber-600 shipped briefly and put the
 * Admin avatar at 3.19:1.
 */
const PALETTE = [
  "bg-sky-700 text-white ring-sky-400/40",
  "bg-emerald-700 text-white ring-emerald-400/40",
  "bg-violet-600 text-white ring-violet-400/40",
  "bg-amber-700 text-white ring-amber-400/40",
  "bg-rose-600 text-white ring-rose-400/40",
  "bg-cyan-700 text-white ring-cyan-400/40",
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function paletteFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export const Avatar = forwardRef<HTMLDivElement, AvatarProps>(
  ({ name, imageUrl, size = "md", className, ...props }, ref) => {
    const initials = initialsOf(name);
    const palette = paletteFor(name);
    return (
      <div
        ref={ref}
        title={name}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ring-inset",
          SIZE_CLASSES[size],
          imageUrl ? "bg-transparent ring-border-strong" : palette,
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
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          initials
        )}
      </div>
    );
  },
);
Avatar.displayName = "Avatar";
