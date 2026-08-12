import { useLoanPortfolio, useRollRate } from "@loan/api-client";
import type {
  AgingBucket,
  RollRateDestination,
  RollRateMatrixRow,
  RollRateOrigin,
} from "@loan/shared-types";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
} from "@loan/ui";
import { formatMoney, formatPercent, todayLocalISO } from "@loan/shared-utils";
import { useState } from "react";
import { Link } from "react-router-dom";

const BUCKET_LABELS: Record<AgingBucket, string> = {
  CURRENT: "Current",
  D_1_30: "1–30 days",
  D_31_60: "31–60 days",
  D_61_90: "61–90 days",
  D_91_120: "91–120 days",
  D_121_180: "121–180 days",
  D_180_PLUS: "180+ days",
};

/*
 * Report order, derived from the labels rather than listed separately.
 *
 * `Record<AgingBucket, string>` makes the labels exhaustive, so adding a
 * band to the type forces a label, which puts it in this list. A
 * hand-kept second array is how a new band ends up rendering nowhere —
 * or worse, rendering but being left out of a total.
 */
const BUCKETS = Object.keys(BUCKET_LABELS) as AgingBucket[];

export function LoanPortfolioPage() {
  const [asOf, setAsOf] = useState(() => todayLocalISO());
  const report = useLoanPortfolio(asOf);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Loan portfolio aging</CardTitle>
          <div className="flex items-center gap-2 text-sm">
            <label className="text-fg-muted">As of</label>
            <DatePicker value={asOf} onChange={setAsOf} className="h-9 w-44" />
          </div>
        </CardHeader>
        <CardContent>
          {report.isLoading ? (
            <SkeletonCard />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              {BUCKETS.map((b) => (
                <div
                  key={b}
                  className="rounded-md border border-default bg-surface-2 p-3"
                >
                  <div className="text-xs uppercase tracking-wider text-fg-subtle">
                    {BUCKET_LABELS[b]}
                  </div>
                  <div className="text-lg font-semibold font-mono mt-1">
                    {formatMoney(report.data?.totals[b] ?? 0)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <RollRateCard />

      <Card>
        <CardHeader>
          <CardTitle>Active loans</CardTitle>
        </CardHeader>
        <CardContent>
          {report.isLoading ? (
            <SkeletonCard />
          ) : (report.data?.rows ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">No active loans.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Loan</th>
                  <th className="py-2 px-2">Customer</th>
                  <th className="py-2 px-2 text-right">Outstanding</th>
                  <th className="py-2 px-2 text-right">Overdue</th>
                  <th className="py-2 px-2 text-right">Days</th>
                  <th className="py-2 px-2">Bucket</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {(report.data?.rows ?? []).map((r) => (
                  <tr key={r.loanId} className="hover:bg-hover">
                    <td className="py-2 px-2 font-mono">
                      <Link
                        to={`/loans/${r.loanNumber}`}
                        className="text-info hover:underline"
                      >
                        {r.loanNumber}
                      </Link>
                    </td>
                    <td className="py-2 px-2">{r.customerName}</td>
                    <td className="py-2 px-2 text-right font-mono">
                      {formatMoney(r.outstandingBalance)}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {r.installmentsOverdue}
                    </td>
                    <td className="py-2 px-2 text-right">{r.daysOverdue}</td>
                    <td className="py-2 px-2">
                      <Badge variant={bucketVariant(r.bucket)}>
                        {BUCKET_LABELS[r.bucket]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-default bg-surface-2 font-semibold">
                  <td className="py-2 px-2" colSpan={2}>
                    Total
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {formatMoney(report.data?.totalOutstanding ?? 0)}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Roll rate (§30) ──────────────────────────────────────────────────

const ORIGIN_LABELS: Record<RollRateOrigin, string> = {
  ...BUCKET_LABELS,
  NEW: "New loans",
};

const DESTINATION_LABELS: Record<RollRateDestination, string> = {
  ...BUCKET_LABELS,
  CLOSED: "Closed",
  WRITTEN_OFF: "Written off",
};

const DAY_MS = 86_400_000;

/**
 * The §30 matrix: row = band at `from`, column = band (or exit) at `to`,
 * cells showing the share of the row's loans that landed there and the
 * exposure that moved. The aging cards above say how late the book IS;
 * this says which way it is GOING.
 */
function RollRateCard() {
  const [from, setFrom] = useState(() =>
    todayLocalISO(new Date(Date.now() - 30 * DAY_MS)),
  );
  const [to, setTo] = useState(() => todayLocalISO());
  const [product, setProduct] = useState("ALL");
  const report = useRollRate(from, to);

  const rows: RollRateMatrixRow[] | undefined =
    product === "ALL"
      ? report.data?.overall
      : report.data?.byProduct.find((p) => p.productCode === product)?.rows;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Roll rate — band migration</CardTitle>
        <div className="flex items-center gap-2 text-sm">
          <Select value={product} onValueChange={setProduct}>
            <SelectTrigger className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All products</SelectItem>
              {(report.data?.byProduct ?? []).map((p) => (
                <SelectItem key={p.productCode} value={p.productCode}>
                  {p.productCode}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="text-fg-muted">From</label>
          <DatePicker value={from} onChange={setFrom} className="h-9 w-40" />
          <label className="text-fg-muted">To</label>
          <DatePicker value={to} onChange={setTo} className="h-9 w-40" />
        </div>
      </CardHeader>
      <CardContent>
        {report.isLoading ? (
          <SkeletonCard />
        ) : report.isError || !report.data || !rows ? (
          <p className="text-sm text-fg-muted">
            Roll-rate data is unavailable — check the date range and that your
            role can read reports.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">At start ↓</th>
                  <th className="py-2 px-2 text-right">Loans</th>
                  <th className="py-2 px-2 text-right">Exposure</th>
                  {report.data.destinations.map((d) => (
                    <th key={d} className="py-2 px-2 text-right">
                      {DESTINATION_LABELS[d]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {rows
                  .filter((r) => r.loanCount > 0)
                  .map((r) => (
                    <tr key={r.origin} className="hover:bg-hover">
                      <td className="py-2 px-2 font-medium">
                        {ORIGIN_LABELS[r.origin]}
                      </td>
                      <td className="py-2 px-2 text-right">{r.loanCount}</td>
                      <td className="py-2 px-2 text-right font-mono">
                        {formatMoney(r.amount)}
                      </td>
                      {r.cells.map((c) => (
                        <td
                          key={c.destination}
                          className="py-2 px-2 text-right"
                        >
                          {c.count === 0 ? (
                            <span className="text-fg-subtle">—</span>
                          ) : (
                            <div>
                              <div className="font-medium">
                                {formatPercent(c.countFraction * 100)}
                              </div>
                              <div className="text-xs text-fg-muted font-mono">
                                {formatMoney(c.amount)}
                              </div>
                            </div>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
            {rows.every((r) => r.loanCount === 0) && (
              <p className="mt-2 text-sm text-fg-muted">
                No loan movements in this window.
              </p>
            )}
            <p className="mt-3 text-xs text-fg-subtle">
              Percentages are the share of each starting band&apos;s loans;
              amounts are gross exposure at the start date (at the end date for
              new loans). Closures include restructured originals.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function bucketVariant(
  b: AgingBucket,
): "success" | "danger" | "muted" | "warning" {
  switch (b) {
    case "CURRENT":
      return "success";
    // Still collectable, and treated as one visual weight so the eye is
    // not asked to rank three shades of "late".
    case "D_1_30":
    case "D_31_60":
    case "D_61_90":
      return "warning";
    // Past the 90-day line: non-performing, whatever the exact band.
    case "D_91_120":
    case "D_121_180":
    case "D_180_PLUS":
      return "danger";
  }
}
