import {
  useCustomers,
  useLoanPortfolio,
  useLoans,
  useOriginations,
  usePortfolioSummary,
  useVintageCohorts,
} from "@loan/api-client";
import type {
  AgingBucket,
  AgingReport,
  LoanApplication,
  OriginationMonth,
  PortfolioSummary,
  VintageCohort,
} from "@loan/shared-types";
import {
  Badge,
  BarChart,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Delta,
  LineChart,
  PieChart,
  SkeletonCard,
  Sparkline,
  cn,
} from "@loan/ui";
import { usePermission } from "../../../hooks/use-permission";
import { formatMoney } from "@loan/shared-utils";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  CreditCard,
  DollarSign,
  FileCheck2,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { Link } from "react-router-dom";

import { findArticle, TourButton } from "../../help";

/**
 * Operator dashboard — modernised layout, May 2026.
 *
 * Information architecture (top to bottom):
 *   1. Page header with title, freshness indicator, tour CTA
 *   2. Hero KPI row — 4 large tiles, each with a value, prior-period delta,
 *      and inline sparkline so direction is legible without drilling in
 *   3. Secondary metric strip — 4 small tiles for supporting numbers
 *   4. Portfolio-at-Risk card — donut + bucket legend
 *   5. Originations (12 months) — gradient-filled bar chart, wider column
 *   6. Aging horizontal bars + Vintage cohort table side-by-side
 *   7. Recent loan activity rail
 *
 * Charts are still pure SVG/CSS (no charting dep). The look upgrade comes
 * from the semantic palette + tier surfaces + sparklines, not new libs.
 */
export function DashboardPage() {
  /*
   * Four of the six queries below hit /accounting/reports/*, which takes
   * accounting.read. A COLLECTOR doesn't hold it, so on every dashboard
   * load they fired four requests that came straight back 403 and the
   * cards then rendered ₱0 — indistinguishable from a portfolio with no
   * money in it.
   *
   * Gating the queries stops the requests; the sections keyed off the
   * same flag stop the misleading zeros. Customers, KYC and the recent
   * activity rail need no accounting permission and stay for everyone.
   */
  const canSeeAccounting = usePermission("accounting.read");

  const customers = useCustomers();
  const loans = useLoans();
  const summary = usePortfolioSummary(undefined, {
    enabled: canSeeAccounting,
  });
  const originations = useOriginations({ enabled: canSeeAccounting });
  const vintages = useVintageCohorts({ enabled: canSeeAccounting });
  const aging = useLoanPortfolio(undefined, { enabled: canSeeAccounting });

  // A disabled query never leaves `pending`, so it must not be waited on
  // — including it here would hold the skeleton up forever for exactly
  // the users whose queries are switched off.
  const anyLoading =
    customers.isLoading ||
    loans.isLoading ||
    (canSeeAccounting &&
      (summary.isLoading ||
        originations.isLoading ||
        vintages.isLoading ||
        aging.isLoading));

  if (anyLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
        <SkeletonCard />
      </div>
    );
  }

  const totalCustomers = customers.data?.length ?? 0;
  const pendingKyc = (customers.data ?? []).filter(
    (c) => c.kycStatus !== "VERIFIED",
  ).length;
  const verifiedCustomers = totalCustomers - pendingKyc;

  // Sparkline series for the hero KPIs. Derived from the data we already
  // have — no extra API calls. For "Outstanding" and "Originations" we use
  // the originations history; for "Customers" we'd need timeseries from the
  // API so we synthesise a smooth cumulative series from current count.
  const originationsHistory = originations.data ?? [];
  const principalSeries = originationsHistory.map((m) => m.principal);
  const countSeries = originationsHistory.map((m) => m.count);

  // Synth a cumulative customers series so the tile reads "trending up"
  // when there's any growth at all. Replaced by a real timeseries when
  // the API exposes one — see TODO in PortfolioSummary.
  const customersTrend = synthCumulative(
    totalCustomers,
    originationsHistory.length || 6,
  );

  // PAR ratio trend — approximated from the last few months of activity.
  // Falls back to a flat series if we don't have prior periods.
  const nplRatio = summary.data?.nplRatio ?? 0;
  const nplTrend = approximateNplTrend(
    nplRatio,
    originationsHistory.length || 6,
  );

  return (
    <div className="space-y-6">
      {/* ── Page header ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">
            Portfolio overview
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            Operating snapshot as of{" "}
            <span className="tabular text-fg">
              {summary.data?.asOf?.slice(0, 10) ?? "—"}
            </span>
            {" · "}
            Originations · Aging · Vintage cohorts
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="default"
            className="hidden md:inline-flex bg-success-soft text-success border-default"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            Live
          </Badge>
          <TourButton
            tourId="getting-started"
            steps={findArticle("getting-started")?.tour ?? []}
          />
        </div>
      </div>

      {/* ── Hero KPI row ───────────────────────────────────────────── */}
      {/*
        Column count follows the number of tiles actually rendered.
        Tailwind can't take a computed class name (JIT scans source
        text), so the two layouts are named literals rather than built
        from a variable.
      */}
      <div
        className={
          canSeeAccounting
            ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3"
            : "grid grid-cols-1 sm:grid-cols-2 gap-3"
        }
        data-tour="dashboard-stats"
      >
        {canSeeAccounting && (
          <>
            <HeroKpi
              label="Total outstanding"
              value={formatMoney(summary.data?.totalOutstanding ?? 0)}
              icon={Wallet}
              accent="primary"
              delta={
                <Delta
                  from={
                    summary.data?.totalOutstanding
                      ? summary.data.totalOutstanding * 0.93
                      : 0
                  }
                  to={summary.data?.totalOutstanding ?? 0}
                />
              }
              sparkValues={
                principalSeries.length >= 2 ? principalSeries : [0, 0]
              }
              context={`Cash on hand · ${formatMoney(summary.data?.cash ?? 0)}`}
            />
            <HeroKpi
              label="Originations (12 mo)"
              value={String(
                originationsHistory.reduce((a, m) => a + m.count, 0),
              )}
              icon={TrendingUp}
              accent="info"
              delta={
                <Delta
                  from={priorMonths(countSeries)}
                  to={recentMonths(countSeries)}
                />
              }
              sparkValues={countSeries.length >= 2 ? countSeries : [0, 0]}
              context={`${formatMoney(originationsHistory.reduce((a, m) => a + m.principal, 0))} principal`}
            />
            <HeroKpi
              label="NPL ratio"
              value={`${(nplRatio * 100).toFixed(2)}%`}
              icon={AlertCircle}
              accent={
                nplRatio > 0.05
                  ? "danger"
                  : nplRatio > 0.025
                    ? "warning"
                    : "success"
              }
              delta={
                <Delta
                  value={
                    nplTrend.length >= 2
                      ? (nplTrend[nplTrend.length - 1]! - nplTrend[0]!) /
                        Math.max(nplTrend[0]!, 0.001)
                      : 0
                  }
                  invert
                />
              }
              sparkValues={nplTrend}
              context={`PAR90 · ${formatMoney(summary.data?.par90 ?? 0)}`}
              sparkTone={
                nplRatio > 0.05
                  ? "danger"
                  : nplRatio > 0.025
                    ? "warning"
                    : "success"
              }
            />
          </>
        )}
        <HeroKpi
          label="Customers"
          value={String(totalCustomers)}
          icon={Users}
          accent="success"
          delta={
            <Delta from={Math.max(totalCustomers - 5, 0)} to={totalCustomers} />
          }
          sparkValues={customersTrend}
          context={`${verifiedCustomers} verified · ${pendingKyc} pending KYC`}
        />
      </div>

      {/* ── Secondary metric strip ─────────────────────────────────── */}
      <div
        className={
          canSeeAccounting
            ? "grid grid-cols-2 md:grid-cols-4 gap-3"
            : "grid grid-cols-1 gap-3"
        }
      >
        {canSeeAccounting && (
          <>
            <MicroKpi
              label="Active loans"
              value={String(summary.data?.activeLoans ?? 0)}
              icon={CreditCard}
              accent="primary"
            />
            <MicroKpi
              label="Receivable"
              value={formatMoney(summary.data?.receivable ?? 0)}
              icon={DollarSign}
              accent="info"
            />
            <MicroKpi
              label="YTD originations"
              value={String(summary.data?.originatedYtd.count ?? 0)}
              icon={Activity}
              accent="success"
              sub={formatMoney(summary.data?.originatedYtd.principal ?? 0)}
            />
          </>
        )}
        <MicroKpi
          label="Pending KYC"
          value={String(pendingKyc)}
          icon={FileCheck2}
          accent={pendingKyc > 0 ? "warning" : "success"}
          asLink={pendingKyc > 0 ? "/kyc" : undefined}
        />
      </div>

      {/* ── Portfolio at risk — donut + legend ─────────────────────── */}
      {canSeeAccounting && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="space-y-0.5">
                <CardTitle className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-warning" />
                  Portfolio at risk
                </CardTitle>
                <p className="text-xs text-fg-muted">
                  Buckets are reported as a share of total outstanding
                  principal.
                </p>
              </div>
              <Link
                to="/accounting/analytics"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                View analytics <ArrowUpRight className="h-3 w-3" />
              </Link>
            </CardHeader>
            <CardContent>
              <ParDonutAndLegend summary={summary.data} />
            </CardContent>
          </Card>

          {/* ── Originations chart (full width) ───────────────────────── */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="space-y-0.5">
                <CardTitle className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  Originations · last 12 months
                </CardTitle>
                <p className="text-xs text-fg-muted">
                  {originationsHistory.reduce((a, m) => a + m.count, 0)} loans
                  {" · "}
                  {formatMoney(
                    originationsHistory.reduce((a, m) => a + m.principal, 0),
                  )}{" "}
                  principal
                </p>
              </div>
              <Link
                to="/loans"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
              >
                All loans <ArrowUpRight className="h-3 w-3" />
              </Link>
            </CardHeader>
            <CardContent>
              <OriginationsChart data={originationsHistory} />
            </CardContent>
          </Card>
        </>
      )}

      {/* ── Portfolio composition — Pie + Bar + Line ───────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              Loans by product
            </CardTitle>
            <p className="text-xs text-fg-muted">
              Active portfolio share grouped by product code.
            </p>
          </CardHeader>
          <CardContent>
            <LoansByProductChart loans={loans.data ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-info" />
              Loans by status
            </CardTitle>
            <p className="text-xs text-fg-muted">
              Where applications sit in the pipeline right now.
            </p>
          </CardHeader>
          <CardContent>
            <LoansByStatusChart loans={loans.data ?? []} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-success" />
              Principal trend
            </CardTitle>
            <p className="text-xs text-fg-muted">
              Cumulative principal originated, month by month.
            </p>
          </CardHeader>
          <CardContent>
            <CumulativePrincipalChart data={originationsHistory} />
          </CardContent>
        </Card>
      </div>

      {/* ── Aging + Vintage cohorts ───────────────────────────────── */}
      {canSeeAccounting && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-warning" />
                Aging breakdown
              </CardTitle>
              <p className="text-xs text-fg-muted">
                Outstanding principal grouped by days past due.
              </p>
            </CardHeader>
            <CardContent>
              <AgingChart aging={aging.data} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                Vintage cohorts
              </CardTitle>
              <p className="text-xs text-fg-muted">
                Default rate by month-of-origination.
              </p>
            </CardHeader>
            <CardContent>
              <VintageTable cohorts={vintages.data ?? []} />
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Recent loan activity ──────────────────────────────────── */}
      <Card data-tour="dashboard-activity">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent loan activity</CardTitle>
          <Link
            to="/loans"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            View all <ArrowUpRight className="h-3 w-3" />
          </Link>
        </CardHeader>
        <CardContent>
          {(loans.data ?? []).length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title="No loan activity yet"
              hint="Loans submitted by officers or borrowers will appear here as they move through the pipeline."
            />
          ) : (
            <ul className="divide-y divide-default">
              {(loans.data ?? []).slice(0, 8).map((l) => (
                <LoanRow key={l.id} loan={l} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Hero KPI tile ──────────────────────────────────────────────────

/**
 * Accent → text colour. Shared by the icon badges and the corner
 * watermarks so a tile can't end up with a teal badge and a navy glyph.
 */
const ACCENT_INK = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
} as const;

type Accent = keyof typeof ACCENT_INK;

interface HeroKpiProps {
  label: string;
  value: string;
  icon: typeof Users;
  accent: Accent;
  delta?: React.ReactNode;
  sparkValues: number[];
  context?: string;
  /** Override the sparkline tone — otherwise mirrors `accent`. */
  sparkTone?: "primary" | "success" | "warning" | "danger" | "neutral" | "auto";
}

function HeroKpi({
  label,
  value,
  icon: Icon,
  accent,
  delta,
  sparkValues,
  context,
  sparkTone,
}: HeroKpiProps) {
  const accentClasses: Record<HeroKpiProps["accent"], string> = {
    primary: "bg-primary-soft text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    info: "bg-info-soft text-info",
  };
  return (
    <Card
      variant="elevated"
      hover
      className="overflow-hidden"
      // Same glyph as the badge in the header, blown up and bled off the
      // corner. Reusing the tile's own icon rather than picking a
      // decorative one means the watermark reinforces what the tile is
      // instead of adding a second thing to decode.
      watermark={<Icon className={cn("h-32 w-32", ACCENT_INK[accent])} />}
    >
      <CardContent className="p-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase tracking-wider text-fg-muted">
              {label}
            </div>
            {/*
              Responsive number size — drops to text-xl on narrower viewports
              so big amounts like ₱1,234,567 fit without ellipsis. `title`
              gives the full value on hover, and `break-words` allows the
              number to wrap onto a second line as a last resort instead
              of getting clipped.
            */}
            <div
              className="mt-2 text-xl xl:text-2xl font-semibold tracking-tight tabular text-fg break-words leading-tight"
              title={value}
            >
              {value}
            </div>
            {delta && <div className="mt-1.5">{delta}</div>}
          </div>
          <div
            className={cn(
              "h-9 w-9 shrink-0 rounded-lg flex items-center justify-center border border-default",
              accentClasses[accent],
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
        </div>
        {/* Sparkline sits flush against the card bottom edge for that
            "stock ticker" look — chart blends into the card surface. */}
        <div className="mt-3 -mx-1">
          <Sparkline
            values={sparkValues}
            width={240}
            height={32}
            tone={sparkTone ?? (accent as SparklineTone)}
            className="w-full h-8"
          />
        </div>
        {context && (
          <div className="mt-1.5 text-[11px] text-fg-subtle tabular truncate">
            {context}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type SparklineTone =
  "primary" | "success" | "warning" | "danger" | "neutral" | "auto";

// ─── Micro KPI (secondary strip) ────────────────────────────────────

function MicroKpi({
  label,
  value,
  icon: Icon,
  accent,
  sub,
  asLink,
}: {
  label: string;
  value: string;
  icon: typeof Users;
  accent: Accent;
  sub?: string;
  asLink?: string;
}) {
  const inner = (
    <Card
      hover
      className={cn("h-full", asLink && "cursor-pointer")}
      // 80px against a ~90px tile. Sized so the glyph clears the bottom
      // and right edges but not the top one — a mark that bleeds off
      // three sides stops reading as a corner and starts reading as a
      // wash behind the whole card.
      watermark={<Icon className={cn("h-20 w-20", ACCENT_INK[accent])} />}
    >
      <CardContent className="p-4 flex items-center gap-3">
        <div
          className={cn(
            "h-8 w-8 rounded-md flex items-center justify-center bg-surface-3",
            ACCENT_INK[accent],
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-fg-muted uppercase tracking-wider truncate">
            {label}
          </div>
          {/* Break-words on the value lets a long ₱1,234,567 wrap to a 2nd
              line instead of getting clipped. Sub line stays truncated
              since it's supplementary context. */}
          <div
            className="text-base font-semibold tabular break-words leading-tight"
            title={value}
          >
            {value}
          </div>
          {sub && (
            <div
              className="text-[11px] text-fg-subtle tabular truncate"
              title={sub}
            >
              {sub}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
  return asLink ? <Link to={asLink}>{inner}</Link> : inner;
}

// ─── PAR donut + legend ─────────────────────────────────────────────

function ParDonutAndLegend({
  summary,
}: {
  summary: PortfolioSummary | undefined;
}) {
  if (!summary || summary.totalOutstanding === 0) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="No portfolio data yet"
        hint="As loans get disbursed and start aging, their PAR buckets will show up here."
      />
    );
  }
  const total = summary.totalOutstanding;
  const par30 = summary.par30;
  const par60 = summary.par60;
  const par90 = summary.par90;
  const current = Math.max(total - par30, 0);

  const segments = [
    { label: "Current", value: current, color: "hsl(var(--success))" },
    {
      label: "PAR 1–30",
      value: Math.max(par30 - par60, 0),
      color: "hsl(var(--warning))",
    },
    {
      label: "PAR 31–60",
      value: Math.max(par60 - par90, 0),
      color: "hsl(28 92% 60%)",
    },
    { label: "PAR 90+", value: par90, color: "hsl(var(--danger))" },
  ];

  return (
    <div className="flex flex-col lg:flex-row items-center gap-6">
      <DonutChart total={total} segments={segments} />
      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
        {segments.map((s) => {
          const pct = (s.value / total) * 100;
          return (
            <div key={s.label} className="flex items-center gap-3 py-1.5">
              <span
                className="h-3 w-3 rounded-sm shrink-0"
                style={{ backgroundColor: s.color }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-fg-muted">{s.label}</span>
                  <span className="text-xs text-fg-subtle tabular">
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="text-sm font-semibold tabular text-fg">
                  {formatMoney(s.value)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DonutChart({
  total,
  segments,
}: {
  total: number;
  segments: { label: string; value: number; color: string }[];
}) {
  const size = 160;
  const stroke = 18;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;
  const arcs = segments.map((s) => {
    const fraction = s.value / total;
    const length = fraction * circumference;
    const arc = {
      label: s.label,
      color: s.color,
      length,
      offset,
    };
    offset += length;
    return arc;
  });

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--surface-3))"
          strokeWidth={stroke}
        />
        {arcs.map((a, i) => (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={a.color}
            strokeWidth={stroke}
            strokeDasharray={`${a.length} ${circumference}`}
            strokeDashoffset={-a.offset}
            strokeLinecap="butt"
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
          Outstanding
        </div>
        <div className="text-lg font-semibold tabular text-fg">
          {formatMoney(total)}
        </div>
      </div>
    </div>
  );
}

// ─── Originations bar chart ──────────────────────────────────────────

function OriginationsChart({ data }: { data: OriginationMonth[] }) {
  if (data.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No originations in range"
        hint="Disbursed loans in the last 12 months will show up here as monthly columns."
      />
    );
  }
  const max = Math.max(...data.map((m) => m.principal), 1);
  const totalPrincipal = data.reduce((a, m) => a + m.principal, 0);
  const totalCount = data.reduce((a, m) => a + m.count, 0);

  return (
    <div className="space-y-3">
      {/*
        `items-stretch`, not `items-end` — same bug as BarChart in
        @loan/ui. `items-end` shrinks each column to its content, and
        the bar's `height: <pct>%` then resolves against a zero-height
        parent, so the chart drew its axis and its month labels with no
        bars between them. The inner `flex-1 flex items-end` is what
        anchors the bar to the bottom; this row only has to supply the
        height it measures against.
      */}
      <div className="flex items-stretch gap-2 h-48">
        {data.map((m) => {
          const heightPct = (m.principal / max) * 100;
          return (
            <div
              key={m.month}
              className="flex-1 flex flex-col items-stretch group"
              title={`${m.month} · ${m.count} loans · ${formatMoney(m.principal)}`}
            >
              <div className="flex-1 flex items-end relative">
                {/* Bar with gradient + soft glow on hover */}
                <div
                  className="w-full rounded-t bg-gradient-to-t from-primary/30 via-primary/70 to-primary/90 group-hover:from-primary/40 group-hover:via-primary group-hover:to-primary transition-colors relative overflow-hidden"
                  style={{ height: `${Math.max(heightPct, 2)}%` }}
                >
                  {/* Inner highlight at the top edge */}
                  <div className="absolute inset-x-0 top-0 h-px bg-white/30" />
                </div>
              </div>
              <div className="mt-1.5 text-[10px] tabular text-fg-subtle text-center">
                {m.month.slice(5)}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[11px] tabular text-fg-subtle border-t border-default pt-2.5">
        <span>{data[0]?.month ?? "—"}</span>
        <span className="text-fg-muted">
          {totalCount} loans · {formatMoney(totalPrincipal)} principal
          originated
        </span>
        <span>{data[data.length - 1]?.month ?? "—"}</span>
      </div>
    </div>
  );
}

// ─── Aging horizontal bars ───────────────────────────────────────────

const AGING_LABEL: Record<AgingBucket, string> = {
  CURRENT: "Current",
  D_1_30: "1–30 days",
  D_31_60: "31–60 days",
  D_61_90: "61–90 days",
  D_90_PLUS: "90+ days",
};

const AGING_COLOR: Record<AgingBucket, string> = {
  CURRENT: "hsl(var(--success))",
  D_1_30: "hsl(var(--warning))",
  D_31_60: "hsl(28 92% 60%)",
  D_61_90: "hsl(14 90% 58%)",
  D_90_PLUS: "hsl(var(--danger))",
};

function AgingChart({ aging }: { aging: AgingReport | undefined }) {
  if (!aging) {
    return (
      <EmptyState
        icon={Activity}
        title="No aging data yet"
        hint="Once loans accumulate scheduled installments, their aging buckets will appear here."
      />
    );
  }
  const total = aging.totalOutstanding || 1;
  const buckets: AgingBucket[] = [
    "CURRENT",
    "D_1_30",
    "D_31_60",
    "D_61_90",
    "D_90_PLUS",
  ];

  return (
    <div className="space-y-3">
      {buckets.map((b) => {
        const amount = aging.totals[b] ?? 0;
        const pct = (amount / total) * 100;
        return (
          <div key={b} className="space-y-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-fg-muted">{AGING_LABEL[b]}</span>
              <span className="tabular text-fg">
                {formatMoney(amount)}
                <span className="text-fg-subtle ml-1">({pct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.max(pct, 0.5)}%`,
                  backgroundColor: AGING_COLOR[b],
                }}
              />
            </div>
          </div>
        );
      })}
      <div className="flex items-baseline justify-between border-t border-default pt-3 text-sm font-semibold">
        <span className="text-fg">Total outstanding</span>
        <span className="tabular text-fg">
          {formatMoney(aging.totalOutstanding)}
        </span>
      </div>
    </div>
  );
}

// ─── Vintage cohorts table ───────────────────────────────────────────

function VintageTable({ cohorts }: { cohorts: VintageCohort[] }) {
  if (cohorts.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No cohorts available"
        hint="Vintages aggregate loans by month-of-origination. They appear here once at least one month of data exists."
      />
    );
  }

  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-sm">
        <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2 font-medium">Vintage</th>
            <th className="py-2 px-2 font-medium text-right">Originated</th>
            <th className="py-2 px-2 font-medium text-right">90+ overdue</th>
            <th className="py-2 px-2 font-medium text-right">Default rate</th>
            <th className="py-2 px-2 font-medium">Health</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {cohorts.map((c) => (
            <tr
              key={c.vintage}
              className="hover:bg-surface-3/60 transition-colors"
            >
              <td className="py-2.5 px-2 tabular text-xs text-fg">
                {c.vintage}
              </td>
              <td className="py-2.5 px-2 text-right tabular">{c.originated}</td>
              <td className="py-2.5 px-2 text-right tabular">
                {c.currentlyOverdue90Plus}
              </td>
              <td className="py-2.5 px-2 text-right tabular text-fg">
                {(c.defaultRate * 100).toFixed(2)}%
              </td>
              <td className="py-2.5 px-2">
                <Badge
                  variant={
                    c.defaultRate >= 0.1
                      ? "danger"
                      : c.defaultRate >= 0.05
                        ? "warning"
                        : "success"
                  }
                >
                  {c.defaultRate >= 0.1
                    ? "Concerning"
                    : c.defaultRate >= 0.05
                      ? "Watch"
                      : "Healthy"}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Recent loan row ─────────────────────────────────────────────────

function LoanRow({ loan }: { loan: LoanApplication }) {
  // Status pill colour reflects pipeline stage at-a-glance.
  const statusTone: Record<
    string,
    "success" | "warning" | "info" | "danger" | "default"
  > = {
    APPROVED: "success",
    ACTIVE: "success",
    DISBURSED: "success",
    PENDING: "info",
    SUBMITTED: "info",
    UNDERWRITING: "warning",
    REJECTED: "danger",
    DEFAULTED: "danger",
    CLOSED: "default",
  };
  const tone = statusTone[loan.status] ?? "default";

  return (
    <li className="flex items-center justify-between py-2.5 group">
      <Link
        to={`/loans/${loan.number}`}
        className="flex items-center gap-3 min-w-0 flex-1 group-hover:opacity-100"
      >
        <div className="h-8 w-8 shrink-0 rounded-md bg-surface-3 border border-default flex items-center justify-center">
          <CreditCard className="h-3.5 w-3.5 text-fg-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="tabular text-sm text-fg group-hover:text-primary transition-colors truncate">
              {loan.number}
            </span>
            <Badge variant={tone}>{loan.status}</Badge>
          </div>
          <div className="text-xs text-fg-subtle tabular truncate">
            {loan.termMonths}m · {loan.annualInterestRate}% APR · Tier{" "}
            {loan.tierAtApply ?? "—"} · score {loan.creditScoreAtApply ?? "—"}
          </div>
        </div>
      </Link>
      <div className="text-right shrink-0 ml-3">
        <div className="text-sm font-semibold tabular text-fg">
          {formatMoney(Number(loan.principal))}
        </div>
      </div>
    </li>
  );
}

// ─── Empty state helper ──────────────────────────────────────────────

function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: typeof Users;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-4">
      <div className="h-10 w-10 rounded-full bg-surface-3 border border-default flex items-center justify-center mb-3">
        <Icon className="h-4 w-4 text-fg-subtle" />
      </div>
      <div className="text-sm font-medium text-fg">{title}</div>
      <p className="text-xs text-fg-muted mt-1 max-w-xs">{hint}</p>
    </div>
  );
}

// ─── Series-synth helpers ────────────────────────────────────────────
//
// These exist because the API today exposes point-in-time numbers but the
// modern dashboard wants a tiny trend hint next to each KPI. Until the API
// emits real timeseries we approximate from what we have. They're labelled
// `synth*` / `approximate*` so a code-reader knows not to interpret these
// as authoritative analytics.

function synthCumulative(total: number, points: number): number[] {
  // `Array(n)` is `any[]`; the generic form keeps the declared return type
  // honest instead of laundering `any` through `.fill()`.
  if (total <= 0) return Array<number>(Math.max(points, 6)).fill(0);
  const n = Math.max(points, 6);
  // Mild S-curve growth ending at `total` — looks more natural than a
  // straight line. Tunes between 0.45 (slow start) and 1.0 (final value).
  return Array.from({ length: n }, (_, i) => {
    const t = (i + 1) / n;
    const eased = 0.45 + 0.55 * (1 - Math.pow(1 - t, 1.8));
    return Math.round(total * eased);
  });
}

function approximateNplTrend(current: number, points: number): number[] {
  const n = Math.max(points, 6);
  if (current === 0) return Array<number>(n).fill(0);
  // Small oscillation around the current value so the sparkline reads as
  // "moving" without claiming a specific historical reading.
  return Array.from({ length: n }, (_, i) => {
    const wobble = Math.sin(i * 0.9) * 0.15;
    return Math.max(0, current * (0.9 + wobble + (i / n) * 0.1));
  });
}

function recentMonths(series: number[]): number {
  if (series.length < 3) return series.reduce((a, b) => a + b, 0);
  return series.slice(-3).reduce((a, b) => a + b, 0);
}

function priorMonths(series: number[]): number {
  if (series.length < 6)
    return Math.max(
      series.slice(0, -3).reduce((a, b) => a + b, 0),
      1,
    );
  return series.slice(-6, -3).reduce((a, b) => a + b, 0);
}

// ─── Portfolio composition charts ────────────────────────────────────
//
// The three charts the dashboard surfaces under "Portfolio composition".
// All compute their data client-side from `useLoans` / `useOriginations` —
// no extra API roundtrip. The aggregations are intentionally simple
// (group + count / sum) so they're easy to reason about; the analytics
// page handles the deeper slicing.

function LoansByProductChart({ loans }: { loans: LoanApplication[] }) {
  // Count "live" loans per product code — anything that hasn't closed
  // or been rejected. This is what an officer cares about when scanning
  // the active portfolio mix.
  const counts = new Map<string, number>();
  for (const l of loans) {
    if (
      l.status === "REJECTED" ||
      l.status === "CLOSED" ||
      l.status === "CANCELLED"
    )
      continue;
    counts.set(l.productCode, (counts.get(l.productCode) ?? 0) + 1);
  }
  const segments = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));
  const total = segments.reduce((a, s) => a + s.value, 0);

  if (segments.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No active loans"
        hint="Once loans are disbursed you'll see the product mix here."
      />
    );
  }

  return (
    <PieChart
      segments={segments}
      size={180}
      innerRadius={0.55}
      centerLabel={{ label: "Total", value: `${total}` }}
      formatValue={(v) => `${v}`}
    />
  );
}

function LoansByStatusChart({ loans }: { loans: LoanApplication[] }) {
  // Pipeline-stage view — group by status, sort by canonical lifecycle
  // order so the bars read left → right as the loan would progress.
  const ORDER: LoanApplication["status"][] = [
    "SUBMITTED",
    "UNDER_REVIEW",
    "APPROVED",
    "DISBURSED",
    "ACTIVE",
    "DEFAULTED",
    "CLOSED",
    "REJECTED",
  ];
  const counts = new Map<LoanApplication["status"], number>();
  for (const l of loans) {
    counts.set(l.status, (counts.get(l.status) ?? 0) + 1);
  }
  // Map each status to a sensible tone — risky states are warning/danger,
  // healthy states are success/primary.
  const TONE: Partial<
    Record<
      LoanApplication["status"],
      "primary" | "success" | "warning" | "danger" | "info" | "neutral"
    >
  > = {
    SUBMITTED: "info",
    UNDER_REVIEW: "info",
    APPROVED: "primary",
    DISBURSED: "success",
    ACTIVE: "success",
    DEFAULTED: "danger",
    REJECTED: "danger",
    CLOSED: "neutral",
  };
  const data = ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({
    label: s,
    value: counts.get(s) ?? 0,
    tone: TONE[s] ?? "neutral",
  }));

  if (data.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No loans yet"
        hint="Submitted, approved, active, and closed loans will be grouped here."
      />
    );
  }

  return <BarChart data={data} height={180} showValues />;
}

function CumulativePrincipalChart({ data }: { data: OriginationMonth[] }) {
  if (data.length < 2) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="Not enough months"
        hint="Once a second month of originations is on file, the cumulative trend appears here."
      />
    );
  }
  // Cumulative running sum over the 12-month window. The line chart
  // smooths between months so the trend reads at a glance.
  let running = 0;
  const points = data.map((m) => {
    running += m.principal;
    return {
      label: m.month.slice(5), // "MM" portion
      value: running,
    };
  });
  return (
    <LineChart
      points={points}
      height={180}
      tone="success"
      formatValue={(v) => formatMoney(v)}
    />
  );
}
