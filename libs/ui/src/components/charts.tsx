import { useId } from "react";
import { cn } from "../lib/cn";

/**
 * Inline SVG chart primitives — no charting dependency.
 *
 * Three shapes today: PieChart (categorical share), BarChart (categorical
 * magnitude), LineChart (continuous trend). Sparkline lives in its own file
 * because it's the trendline-on-a-KPI-tile case with no labels — these
 * three render labels + axes + legend.
 *
 * Why hand-rolled: the dashboard needs a handful of small visualisations
 * and pulling in recharts / chart.js for that would more than double the
 * vendor bundle. We pay for the lib-code only when the data is non-trivial
 * (e.g. analytics page) — for the dashboard, simple SVG primitives are
 * lighter, theme-aware, and easier to reason about.
 *
 * All three accept colors via CSS variables so a theme tweak applies
 * automatically.
 */

// ─── Tone palette ────────────────────────────────────────────────────

export type ChartTone =
  "primary" | "success" | "warning" | "danger" | "info" | "neutral";

const TONE_VAR: Record<ChartTone, string> = {
  primary: "--primary",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  info: "--info",
  neutral: "--foreground-muted",
};

const toneCss = (t: ChartTone) => `hsl(var(${TONE_VAR[t]}))`;

/**
 * Default palette for multi-series charts. Loops if you have more
 * categories than tones — callers can pass their own colors per segment
 * for full control.
 */
const PALETTE: ChartTone[] = [
  "primary",
  "success",
  "warning",
  "info",
  "danger",
  "neutral",
];

/**
 * The panel a chart is drawn on.
 *
 * Ink floating directly on a card reads as decoration; a plot area
 * with its own fill and a border reads as a chart. It also gives the
 * gridlines somewhere to live — they'd be noise against the card, but
 * they're a reading aid against a distinct surface.
 *
 * Class rather than an inline fill so the two tokens (`--chart-plot`,
 * `--chart-grid`) stay the only place this is tuned.
 */
export const PLOT_SURFACE =
  "rounded-lg border border-default bg-chart-plot p-3";

/** Horizontal reference lines at quarters. Drawn under the data. */
function GridLines({
  width,
  height,
  padX,
  padY,
}: {
  width: number;
  height: number;
  padX: number;
  padY: number;
}) {
  const rows = [0, 0.25, 0.5, 0.75, 1];
  return (
    <g>
      {rows.map((r) => {
        const y = padY + r * (height - padY * 2);
        return (
          <line
            key={r}
            x1={padX}
            y1={y}
            x2={width - padX}
            y2={y}
            stroke="hsl(var(--chart-grid))"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            // The baseline is the data's floor and reads as an axis;
            // the rest are just guides.
            strokeDasharray={r === 1 ? undefined : "3 4"}
          />
        );
      })}
    </g>
  );
}

// ─── PieChart ────────────────────────────────────────────────────────

export interface PieSegment {
  label: string;
  value: number;
  /** Optional explicit color (CSS color). Otherwise the next palette tone. */
  color?: string;
}

export interface PieChartProps {
  segments: PieSegment[];
  /** Outer diameter in pixels. */
  size?: number;
  /**
   * Inner radius for a donut effect (0..1). Defaults to 0 = full pie.
   * Set ~0.55 for a typical "donut with center label" look.
   */
  innerRadius?: number;
  /** Show the inline legend below the chart. */
  showLegend?: boolean;
  /** Total label shown in the donut hole when `innerRadius > 0`. */
  centerLabel?: { label: string; value: string };
  className?: string;
  /** Format the value for the legend. Defaults to plain `String(v)`. */
  formatValue?: (v: number) => string;
}

export function PieChart({
  segments,
  size = 180,
  innerRadius = 0,
  showLegend = true,
  centerLabel,
  className,
  formatValue,
}: PieChartProps) {
  const total = segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
  if (segments.length === 0 || total <= 0) {
    return (
      <div className={cn("text-xs text-fg-subtle text-center py-4", className)}>
        No data
      </div>
    );
  }
  const r = size / 2;
  const innerR = r * innerRadius;
  // Start at 12 o'clock and go clockwise — matches the donut chart used
  // elsewhere (PAR strip) so users see consistent direction.
  let cursorRad = -Math.PI / 2;

  const arcs = segments.map((s, i) => {
    const fraction = Math.max(0, s.value) / total;
    const sweep = fraction * Math.PI * 2;
    const startRad = cursorRad;
    const endRad = cursorRad + sweep;
    cursorRad = endRad;

    const color = s.color ?? toneCss(PALETTE[i % PALETTE.length]!);
    return { ...s, fraction, color, startRad, endRad };
  });

  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {arcs.map((a, i) => (
            <path
              key={i}
              d={arcPath(r, r, r, innerR, a.startRad, a.endRad)}
              fill={a.color}
              // Hairline gap between slices for clarity.
              stroke="hsl(var(--background))"
              strokeWidth={1}
            />
          ))}
        </svg>
        {centerLabel && innerRadius > 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
              {centerLabel.label}
            </div>
            <div className="text-sm font-semibold tabular text-fg">
              {centerLabel.value}
            </div>
          </div>
        )}
      </div>
      {showLegend && (
        <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {arcs.map((a, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="h-2.5 w-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: a.color }}
                />
                <span className="text-fg-muted truncate">{a.label}</span>
              </div>
              <span className="tabular text-fg-subtle shrink-0">
                {formatValue ? formatValue(a.value) : a.value}
                {" · "}
                {(a.fraction * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Build a single annulus-sector ("donut slice") path. Used by PieChart
 * to render both filled pies (innerR=0) and donut variants.
 */
function arcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startRad: number,
  endRad: number,
): string {
  // Full-circle special case — SVG arcs can't span 360° in one segment,
  // so we draw two semicircles. Common when the data has only one slice.
  const span = endRad - startRad;
  if (Math.abs(span - Math.PI * 2) < 1e-6) {
    const ox = cx + outerR;
    const innerInsidePath =
      innerR > 0
        ? ` M ${cx + innerR} ${cy} A ${innerR} ${innerR} 0 1 0 ${cx - innerR} ${cy} A ${innerR} ${innerR} 0 1 0 ${cx + innerR} ${cy} Z`
        : "";
    return `M ${ox} ${cy} A ${outerR} ${outerR} 0 1 1 ${cx - outerR} ${cy} A ${outerR} ${outerR} 0 1 1 ${ox} ${cy} Z${innerInsidePath}`;
  }
  const largeArc = span > Math.PI ? 1 : 0;
  const sx = cx + outerR * Math.cos(startRad);
  const sy = cy + outerR * Math.sin(startRad);
  const ex = cx + outerR * Math.cos(endRad);
  const ey = cy + outerR * Math.sin(endRad);

  if (innerR <= 0) {
    return `M ${cx} ${cy} L ${sx} ${sy} A ${outerR} ${outerR} 0 ${largeArc} 1 ${ex} ${ey} Z`;
  }
  const isx = cx + innerR * Math.cos(endRad);
  const isy = cy + innerR * Math.sin(endRad);
  const iex = cx + innerR * Math.cos(startRad);
  const iey = cy + innerR * Math.sin(startRad);
  return (
    `M ${sx} ${sy}` +
    ` A ${outerR} ${outerR} 0 ${largeArc} 1 ${ex} ${ey}` +
    ` L ${isx} ${isy}` +
    ` A ${innerR} ${innerR} 0 ${largeArc} 0 ${iex} ${iey}` +
    " Z"
  );
}

// ─── BarChart (vertical) ─────────────────────────────────────────────

export interface BarDatum {
  label: string;
  value: number;
  tone?: ChartTone;
  /** Optional explicit color override (CSS). */
  color?: string;
}

export interface BarChartProps {
  data: BarDatum[];
  /** Total chart height in px. The drawn bars get the inner area. */
  height?: number;
  /** Optional value formatter for the on-hover title attr. */
  formatValue?: (v: number) => string;
  /** Show value on top of each bar. */
  showValues?: boolean;
  className?: string;
}

export function BarChart({
  data,
  height = 160,
  formatValue,
  showValues = false,
  className,
}: BarChartProps) {
  if (data.length === 0) {
    return (
      <div className={cn("text-xs text-fg-subtle text-center py-4", className)}>
        No data
      </div>
    );
  }
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className={cn("space-y-2", PLOT_SURFACE, className)}>
      <div className="relative flex items-end gap-2" style={{ height }}>
        {/* Quarter guides behind the bars — reading a height off a
            flat panel is guesswork without them. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {[0, 0.25, 0.5, 0.75].map((r) => (
            <div
              key={r}
              className="absolute inset-x-0 border-t border-dashed"
              style={{
                top: `${r * 100}%`,
                borderColor: "hsl(var(--chart-grid))",
              }}
            />
          ))}
          <div
            className="absolute inset-x-0 bottom-0 border-t"
            style={{ borderColor: "hsl(var(--chart-grid))" }}
          />
        </div>
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const color =
            d.color ?? toneCss(d.tone ?? PALETTE[i % PALETTE.length]!);
          const title = formatValue
            ? `${d.label}: ${formatValue(d.value)}`
            : `${d.label}: ${d.value}`;
          return (
            <div
              key={d.label + i}
              className="flex-1 flex flex-col items-stretch gap-1 group"
              title={title}
            >
              {showValues && (
                <div className="text-[10px] text-fg-subtle text-center tabular">
                  {formatValue ? formatValue(d.value) : d.value}
                </div>
              )}
              <div className="flex-1 flex items-end">
                <div
                  className="w-full rounded-t transition-opacity group-hover:opacity-90 relative overflow-hidden"
                  style={{
                    height: `${Math.max(pct, 2)}%`,
                    background: `linear-gradient(to top, ${color}80, ${color})`,
                  }}
                >
                  <div className="absolute inset-x-0 top-0 h-px bg-white/30" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {/* Labels live in their own row so they don't compete with the
          bars for vertical space — long labels wrap; sparse-axis style. */}
      <div className="flex items-start gap-2">
        {data.map((d, i) => (
          <div
            key={d.label + i}
            className="flex-1 text-[10px] text-fg-subtle text-center tabular break-words"
          >
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── LineChart ───────────────────────────────────────────────────────

export interface LinePoint {
  label: string;
  value: number;
}

export interface LineChartProps {
  points: LinePoint[];
  height?: number;
  tone?: ChartTone;
  /** Show area fill below the line. */
  filled?: boolean;
  /** Show points at each data position. */
  showDots?: boolean;
  /** Format the value for tooltip / Y-axis annotation. */
  formatValue?: (v: number) => string;
  className?: string;
}

export function LineChart({
  points,
  height = 180,
  tone = "primary",
  filled = true,
  showDots = true,
  formatValue,
  className,
}: LineChartProps) {
  const gradientId = useId();
  if (points.length < 2) {
    return (
      <div className={cn("text-xs text-fg-subtle text-center py-4", className)}>
        Not enough data
      </div>
    );
  }
  // Use an internal viewBox the line is drawn into, then let the SVG
  // scale to whatever container width the caller provides. Keeps the
  // chart responsive without re-rendering on resize.
  const VB_W = 600;
  const VB_H = height;
  const padX = 16;
  const padY = 12;

  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const range = max - min || 1;
  const stepX = (VB_W - padX * 2) / (points.length - 1);

  const coords = points.map((p, i) => ({
    x: padX + i * stepX,
    y: VB_H - padY - ((p.value - min) / range) * (VB_H - padY * 2),
    point: p,
  }));

  const linePath = buildSmoothLine(coords.map((c) => ({ x: c.x, y: c.y })));
  const areaPath = `${linePath} L ${VB_W - padX} ${VB_H - padY} L ${padX} ${VB_H - padY} Z`;

  const color = toneCss(tone);

  return (
    <div className={cn("w-full", PLOT_SURFACE, className)}>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.45} />
            <stop offset="55%" stopColor={color} stopOpacity={0.14} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <GridLines width={VB_W} height={VB_H} padX={padX} padY={padY} />
        {filled && <path d={areaPath} fill={`url(#${gradientId})`} />}
        <path
          d={linePath}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {showDots &&
          coords.map((c, i) => (
            <circle
              key={i}
              cx={c.x}
              cy={c.y}
              r={3}
              fill="hsl(var(--chart-plot))"
              stroke={color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            >
              <title>
                {c.point.label}:{" "}
                {formatValue ? formatValue(c.point.value) : c.point.value}
              </title>
            </circle>
          ))}
      </svg>
      <div className="flex justify-between text-[10px] tabular text-fg-subtle mt-1 px-1">
        {points.map((p, i) => (
          <span key={i}>{p.label}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Catmull-Rom → Bézier smoothing. Same approach as the Sparkline helper —
 * passes through every point without overshooting. Inlined here so the
 * chart components stay self-contained.
 */
function buildSmoothLine(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]!;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}
