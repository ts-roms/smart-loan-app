import { useLoanPortfolio } from "@loan/api-client";
import type { AgingBucket } from "@loan/shared-types";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  SkeletonCard,
} from "@loan/ui";
import { formatMoney, todayLocalISO } from "@loan/shared-utils";
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
