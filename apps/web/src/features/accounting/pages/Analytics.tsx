import {
  useOriginations,
  usePortfolioSummary,
  useVintageCohorts,
} from "@loan/api-client";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { Activity, AlertCircle, DollarSign, TrendingUp } from "lucide-react";

/**
 * Portfolio analytics — the single page lenders look at every morning.
 *
 *   Top tiles  : cash, receivable, NPL %, active loan count
 *   PAR row    : par30 / par60 / par90 outstanding
 *   Originations chart : monthly count + principal (12 months)
 *   Vintage cohorts    : default rate by origination month
 *
 * Charts are simple CSS bars — sufficient for the MVP; swap in recharts
 * when you need tooltips, animations, etc.
 */
export function AnalyticsPage() {
  const summary = usePortfolioSummary();
  const originations = useOriginations();
  const vintages = useVintageCohorts();

  if (summary.isLoading || originations.isLoading || vintages.isLoading) {
    return <SkeletonCard />;
  }

  const s = summary.data!;
  const orig = originations.data ?? [];
  const cohorts = vintages.data ?? [];
  const maxPrincipal = orig.length
    ? Math.max(...orig.map((o) => o.principal))
    : 0;
  const maxOriginated = cohorts.length
    ? Math.max(...cohorts.map((c) => c.originated))
    : 0;

  return (
    <div className="space-y-4">
      {/* Top tiles */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Stat
          label="Cash"
          icon={DollarSign}
          value={formatMoney(s.cash)}
          accent="emerald"
        />
        <Stat
          label="Loans receivable"
          icon={Activity}
          value={formatMoney(s.receivable)}
          accent="sky"
        />
        <Stat
          label="NPL ratio"
          icon={AlertCircle}
          value={`${(s.nplRatio * 100).toFixed(2)}%`}
          accent={s.nplRatio > 0.05 ? "rose" : "amber"}
        />
        <Stat
          label="Active loans"
          icon={TrendingUp}
          value={String(s.activeLoans)}
          accent="sky"
        />
      </div>

      {/* PAR row */}
      <Card>
        <CardHeader>
          <CardTitle>Portfolio at risk</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
            <Info label="Outstanding total">
              {formatMoney(s.totalOutstanding)}
            </Info>
            <Info label="PAR30">{formatMoney(s.par30)}</Info>
            <Info label="PAR60">{formatMoney(s.par60)}</Info>
            <Info label="PAR90">{formatMoney(s.par90)}</Info>
          </div>
        </CardContent>
      </Card>

      {/* Originations chart */}
      <Card>
        <CardHeader>
          <CardTitle>Originations</CardTitle>
        </CardHeader>
        <CardContent>
          {orig.length === 0 ? (
            <p className="text-sm text-fg-muted">No originations in range.</p>
          ) : (
            <div className="space-y-2">
              {orig.map((m) => (
                <div key={m.month} className="text-xs">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono">{m.month}</span>
                    <span className="text-fg-muted">
                      {m.count} loan{m.count === 1 ? "" : "s"} ·{" "}
                      {formatMoney(m.principal)}
                    </span>
                  </div>
                  <div className="h-2 rounded bg-surface-2 overflow-hidden">
                    <div
                      className="h-full bg-info/70"
                      style={{
                        width: `${maxPrincipal > 0 ? (m.principal / maxPrincipal) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Vintage cohorts */}
      <Card>
        <CardHeader>
          <CardTitle>
            Vintage cohorts (default rate by origination month)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {cohorts.length === 0 ? (
            <p className="text-sm text-fg-muted">No cohorts available.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Vintage</th>
                  <th className="py-2 px-2 text-right">Originated</th>
                  <th className="py-2 px-2 text-right">Overdue 90+</th>
                  <th className="py-2 px-2 text-right">Default rate</th>
                  <th className="py-2 px-2">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {cohorts.map((c) => (
                  <tr key={c.vintage} className="hover:bg-hover">
                    <td className="py-2 px-2 font-mono">{c.vintage}</td>
                    <td className="py-2 px-2 text-right">{c.originated}</td>
                    <td className="py-2 px-2 text-right">
                      {c.currentlyOverdue90Plus}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {(c.defaultRate * 100).toFixed(2)}%
                    </td>
                    <td className="py-2 px-2">
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
                      <div className="h-1 mt-1 rounded bg-surface-2 overflow-hidden">
                        <div
                          className="h-full bg-surface-3"
                          style={{
                            width: `${maxOriginated > 0 ? (c.originated / maxOriginated) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  icon: typeof Activity;
  accent: "sky" | "amber" | "emerald" | "rose";
}) {
  const colors = {
    sky: "text-info bg-info/10 border-info/20",
    amber: "text-warning bg-warning/10 border-warning/20",
    emerald: "text-success bg-success/10 border-success/20",
    rose: "text-danger bg-danger/10 border-danger/20",
  };
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          <div className="text-xs text-fg-muted uppercase tracking-wider">
            {label}
          </div>
          <div className="text-2xl font-semibold tracking-tight truncate">
            {value}
          </div>
        </div>
        <div
          className={`h-10 w-10 rounded-md border flex items-center justify-center ${colors[accent]}`}
        >
          <Icon className="h-5 w-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function Info({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="text-base font-mono">{children ?? "—"}</div>
    </div>
  );
}
