import { useId } from "react";
import { cn } from "../lib/cn";

/**
 * Inline trend sparkline — pure SVG, no charting dependency.
 *
 * Designed to sit next to a KPI value in a dashboard tile: small enough
 * to read at-a-glance but detailed enough to communicate direction.
 * The line is drawn over a soft gradient fill so it reads as a region,
 * not a chart axis-less wireframe.
 *
 * Usage:
 *   <Sparkline values={[10, 12, 11, 14, 18, 17, 22]} tone="success" />
 *
 * The component never renders axis labels — that's the point of a
 * sparkline. If you need an axis, use the full chart on the analytics
 * page. The values array is the only data input; we normalise to fit
 * the SVG viewport so callers can pass raw counts / amounts.
 */
export interface SparklineProps {
  /** Numeric series, oldest first. 2-100 points typical; <2 renders empty. */
  values: number[];
  /** Visual width in pixels. */
  width?: number;
  /** Visual height in pixels. */
  height?: number;
  /**
   * Colour tone. Pulls from the semantic palette so a future theme tweak
   * applies here automatically. `auto` picks based on first-to-last delta.
   */
  tone?: "primary" | "success" | "warning" | "danger" | "neutral" | "auto";
  /** Show the gradient area fill under the line. Defaults true. */
  filled?: boolean;
  /** Optional class for the root <svg>. */
  className?: string;
  /**
   * Accessible label. If omitted we generate one from the trend direction
   * + first/last values so screen readers get something useful.
   */
  ariaLabel?: string;
}

const TONE_VAR = {
  primary: "--primary",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  neutral: "--foreground-muted",
} as const;

export function Sparkline({
  values,
  width = 96,
  height = 28,
  tone = "auto",
  filled = true,
  className,
  ariaLabel,
}: SparklineProps) {
  const gradientId = useId();

  if (values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={cn("block", className)}
        aria-hidden={!ariaLabel}
        aria-label={ariaLabel}
      />
    );
  }

  // Auto-tone: green if last >= first, red if down, neutral if flat.
  // Narrow the type so the TONE_VAR lookup below is statically known to
  // be exhaustive (`auto` is a caller convenience, not a real palette).
  let resolvedTone: Exclude<SparklineProps["tone"], "auto" | undefined>;
  if (tone === "auto") {
    const first = values[0]!;
    const last = values[values.length - 1]!;
    const diff = last - first;
    const noise = Math.max(Math.abs(first), 1) * 0.01;
    if (Math.abs(diff) <= noise) resolvedTone = "neutral";
    else resolvedTone = diff > 0 ? "success" : "danger";
  } else {
    resolvedTone = tone ?? "primary";
  }
  const cssVar = TONE_VAR[resolvedTone];

  // Normalise into the viewport. Add 1px of vertical padding so the line
  // doesn't clip against the top/bottom edges at extrema.
  const padY = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const yNorm = (v - min) / range;
    const y = height - padY - yNorm * (height - padY * 2);
    return { x, y };
  });

  // Build smooth line via cubic Bézier midpoints — much nicer at small sizes
  // than straight polylines, and cheaper than a real spline library.
  const linePath = buildSmoothPath(points);
  // Area path closes the line down to the baseline so a fill can render.
  const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

  // Sensible default a11y label.
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const direction = last > first ? "up" : last < first ? "down" : "flat";
  const fallbackLabel = `Trend ${direction} from ${first} to ${last}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("block overflow-visible", className)}
      role="img"
      aria-label={ariaLabel ?? fallbackLabel}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor={`hsl(var(${cssVar}))`}
            stopOpacity={0.35}
          />
          <stop
            offset="100%"
            stopColor={`hsl(var(${cssVar}))`}
            stopOpacity={0}
          />
        </linearGradient>
      </defs>
      {filled && <path d={areaPath} fill={`url(#${gradientId})`} />}
      <path
        d={linePath}
        fill="none"
        stroke={`hsl(var(${cssVar}))`}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Last-point dot so the eye can find the current value. */}
      <circle
        cx={points[points.length - 1]!.x}
        cy={points[points.length - 1]!.y}
        r={2}
        fill={`hsl(var(${cssVar}))`}
      />
    </svg>
  );
}

/**
 * Builds a smooth path through the given points using Catmull-Rom-to-Bézier
 * conversion. Each segment uses the midpoint of its neighbours as the
 * control direction, which produces a curve that always passes through
 * every point — important for sparklines (no overshoot drama).
 */
function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;

  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]!;
    // Standard Catmull-Rom → Bézier tension. 6 is the classic factor for a
    // visually pleasing 'natural' spline.
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
