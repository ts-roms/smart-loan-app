import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Compact trend indicator — arrow + signed percentage — for KPI tiles.
 *
 *   <Delta from={prior} to={current} />            // computes pct
 *   <Delta value={0.124} />                        // pre-computed (12.4%)
 *   <Delta value={-0.03} invert />                 // smaller-is-better
 *
 * Why the `invert` flag: for some metrics (NPL ratio, default rate, PAR90)
 * a *decrease* is the good outcome, so we colour the arrow accordingly.
 * Pass `invert` and the green/red mapping flips.
 *
 * Zero-or-near-zero deltas render in the neutral muted-foreground colour
 * with a horizontal arrow, so a stale KPI doesn't look like a positive
 * trend.
 */
export interface DeltaProps {
  /**
   * Pre-computed delta as a decimal fraction. 0.05 renders as "+5.0%".
   * Either `value` OR `from`+`to` must be provided.
   */
  value?: number;
  /** Prior-period number. Used with `to` to compute the delta. */
  from?: number;
  /** Current-period number. Used with `from` to compute the delta. */
  to?: number;
  /** Flip the green/red mapping when smaller is better (e.g. NPL ratio). */
  invert?: boolean;
  /** Hide the arrow glyph — just the percentage in tone-coloured text. */
  hideArrow?: boolean;
  /** Optional className applied to the wrapping <span>. */
  className?: string;
}

export function Delta({
  value,
  from,
  to,
  invert = false,
  hideArrow = false,
  className,
}: DeltaProps) {
  // Resolve the delta. If `value` is given use it; otherwise compute from
  // from/to. If both ends are zero we treat the metric as not-yet-tracked
  // and render a tilde rather than +Infinity / NaN.
  let pct: number | null;
  if (typeof value === "number") {
    pct = value;
  } else if (typeof from === "number" && typeof to === "number") {
    if (from === 0) {
      pct = to === 0 ? 0 : null;
    } else {
      pct = (to - from) / Math.abs(from);
    }
  } else {
    pct = null;
  }

  if (pct === null) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 text-fg-subtle text-xs",
          className,
        )}
      >
        <ArrowRight className="h-3 w-3" />
        <span className="tabular">—</span>
      </span>
    );
  }

  // Anything inside ±0.5% is visual noise on a portfolio — show as flat.
  const isFlat = Math.abs(pct) < 0.005;
  const isUp = pct > 0;

  // Tone: up + !invert = success, up + invert = danger, etc.
  let tone: "success" | "danger" | "neutral";
  if (isFlat) tone = "neutral";
  else if (isUp) tone = invert ? "danger" : "success";
  else tone = invert ? "success" : "danger";

  const Icon = isFlat ? ArrowRight : isUp ? ArrowUpRight : ArrowDownRight;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium tabular",
        tone === "success" && "text-success",
        tone === "danger" && "text-danger",
        tone === "neutral" && "text-fg-subtle",
        className,
      )}
    >
      {!hideArrow && <Icon className="h-3 w-3" />}
      <span>
        {isUp && !isFlat ? "+" : ""}
        {(pct * 100).toFixed(pct >= 0.1 || pct <= -0.1 ? 0 : 1)}%
      </span>
    </span>
  );
}
