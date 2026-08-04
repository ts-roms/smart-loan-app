import {
  useBalanceSheet,
  useIncomeStatement,
  useLoanPortfolio,
  useTrialBalance,
} from "@loan/api-client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import {
  BookOpenCheck,
  CircleDollarSign,
  Landmark,
  Receipt,
  TrendingUp,
} from "lucide-react";
import { Link } from "react-router-dom";

import { findArticle, TourButton } from "../../help";

/**
 * Top-level accounting dashboard. Six widgets:
 *   - Cash on hand (from balance sheet)
 *   - Loans receivable (from balance sheet)
 *   - Net income YTD
 *   - Outstanding (from aging report) + delinquent buckets
 *   - Trial balance status
 *   - Shortcuts to the rest of the module
 */
export function AccountingDashboardPage() {
  const trial = useTrialBalance();
  const incomeStmt = useIncomeStatement();
  const balance = useBalanceSheet();
  const aging = useLoanPortfolio();

  if (
    trial.isLoading ||
    incomeStmt.isLoading ||
    balance.isLoading ||
    aging.isLoading
  ) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SkeletonCard /> <SkeletonCard /> <SkeletonCard />
      </div>
    );
  }

  const cash =
    balance.data?.assets.rows.find((r) => r.code === "1000")?.amount ?? 0;
  const receivable =
    balance.data?.assets.rows.find((r) => r.code === "1100")?.amount ?? 0;
  const netIncome = incomeStmt.data?.netIncome ?? 0;
  const delinquent =
    (aging.data?.totals.D_1_30 ?? 0) +
    (aging.data?.totals.D_31_60 ?? 0) +
    (aging.data?.totals.D_61_90 ?? 0) +
    (aging.data?.totals.D_90_PLUS ?? 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-lg font-semibold tracking-tight">Accounting</div>
          <div className="text-xs text-fg-muted">General ledger snapshot</div>
        </div>
        <TourButton
          tourId="accounting"
          steps={findArticle("accounting")?.tour ?? []}
        />
      </div>

      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3"
        data-tour="accounting-stats"
      >
        <StatCard
          label="Cash"
          value={formatMoney(cash)}
          icon={CircleDollarSign}
          accent="emerald"
        />
        <StatCard
          label="Loans receivable"
          value={formatMoney(receivable)}
          icon={Receipt}
          accent="sky"
        />
        <StatCard
          label="Net income YTD"
          value={formatMoney(netIncome)}
          icon={TrendingUp}
          accent="amber"
        />
        <StatCard
          label="Delinquent"
          value={formatMoney(delinquent)}
          icon={Landmark}
          accent="rose"
        />
      </div>

      <Card data-tour="accounting-reports">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpenCheck className="h-4 w-4" />
            Reports
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <ReportLink
              to="/accounting/trial-balance"
              title="Trial balance"
              subtitle={`${trial.data?.inBalance ? "In balance" : "Out of balance"}`}
            />
            <ReportLink
              to="/accounting/income-statement"
              title="Income statement"
              subtitle={`Net: ${formatMoney(netIncome)}`}
            />
            <ReportLink
              to="/accounting/balance-sheet"
              title="Balance sheet"
              subtitle={`Assets: ${formatMoney(balance.data?.assets.total ?? 0)}`}
            />
            <ReportLink
              to="/accounting/portfolio"
              title="Loan portfolio"
              subtitle={`${aging.data?.rows.length ?? 0} active`}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-tour="accounting-aging">
          <CardHeader>
            <CardTitle>Aging buckets</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-default text-sm">
              {(
                [
                  "CURRENT",
                  "D_1_30",
                  "D_31_60",
                  "D_61_90",
                  "D_90_PLUS",
                ] as const
              ).map((b) => (
                <li key={b} className="flex items-center justify-between py-2">
                  <span className="text-fg">{labelFor(b)}</span>
                  <span className="font-mono">
                    {formatMoney(aging.data?.totals[b] ?? 0)}
                  </span>
                </li>
              ))}
              <li className="flex items-center justify-between py-2 font-semibold">
                <span>Total outstanding</span>
                <span className="font-mono">
                  {formatMoney(aging.data?.totalOutstanding ?? 0)}
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick links</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  className="text-info hover:underline"
                  to="/accounting/accounts"
                >
                  Chart of accounts →
                </Link>
              </li>
              <li>
                <Link
                  className="text-info hover:underline"
                  to="/accounting/journal"
                >
                  Journal entries →
                </Link>
              </li>
              <li>
                <Link
                  className="text-info hover:underline"
                  to="/accounting/portfolio"
                >
                  Loan portfolio aging →
                </Link>
              </li>
              <li>
                <Link
                  className="text-info hover:underline"
                  to="/accounting/periods"
                >
                  Periods & accrual →
                </Link>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function labelFor(bucket: string): string {
  switch (bucket) {
    case "CURRENT":
      return "Current";
    case "D_1_30":
      return "1–30 days overdue";
    case "D_31_60":
      return "31–60 days overdue";
    case "D_61_90":
      return "61–90 days overdue";
    case "D_90_PLUS":
      return "90+ days overdue";
    default:
      return bucket;
  }
}

function StatCard({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  icon: typeof CircleDollarSign;
  accent: "sky" | "amber" | "emerald" | "rose";
}) {
  const colors = {
    sky: "text-info bg-sky-500/10 border-sky-400/20",
    amber: "text-warning bg-amber-500/10 border-amber-400/20",
    emerald: "text-success bg-emerald-500/10 border-emerald-400/20",
    rose: "text-danger bg-rose-500/10 border-rose-400/20",
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

function ReportLink({
  to,
  title,
  subtitle,
}: {
  to: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      to={to}
      className="rounded-md border border-default bg-surface-2 hover:bg-hover transition-colors p-3 block"
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-fg-muted mt-1">{subtitle}</div>
    </Link>
  );
}
