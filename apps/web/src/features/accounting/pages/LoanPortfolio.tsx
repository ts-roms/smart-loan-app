import { useLoanPortfolio } from '@loan/api-client';
import type { AgingBucket } from '@loan/shared-types';
import { Badge, Card, CardContent, CardHeader, CardTitle, DatePicker, SkeletonCard } from '@loan/ui';
import { formatMoney } from '@loan/shared-utils';
import { useState } from 'react';
import { Link } from 'react-router-dom';

const BUCKETS: AgingBucket[] = ['CURRENT', 'D_1_30', 'D_31_60', 'D_61_90', 'D_90_PLUS'];

const BUCKET_LABELS: Record<AgingBucket, string> = {
  CURRENT: 'Current',
  D_1_30: '1–30 days',
  D_31_60: '31–60 days',
  D_61_90: '61–90 days',
  D_90_PLUS: '90+ days',
};

export function LoanPortfolioPage() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const report = useLoanPortfolio(asOf);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Loan portfolio aging</CardTitle>
          <div className="flex items-center gap-2 text-sm">
            <label className="text-white/55">As of</label>
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
                  className="rounded-md border border-white/10 bg-white/[0.03] p-3"
                >
                  <div className="text-xs uppercase tracking-wider text-white/45">
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
            <p className="text-sm text-white/55">No active loans.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                <tr>
                  <th className="py-2 px-2">Loan</th>
                  <th className="py-2 px-2">Customer</th>
                  <th className="py-2 px-2 text-right">Outstanding</th>
                  <th className="py-2 px-2 text-right">Overdue</th>
                  <th className="py-2 px-2 text-right">Days</th>
                  <th className="py-2 px-2">Bucket</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(report.data?.rows ?? []).map((r) => (
                  <tr key={r.loanId} className="hover:bg-white/[0.03]">
                    <td className="py-2 px-2 font-mono">
                      <Link to={`/loans/${r.loanId}`} className="text-sky-300 hover:underline">
                        {r.loanNumber}
                      </Link>
                    </td>
                    <td className="py-2 px-2">{r.customerName}</td>
                    <td className="py-2 px-2 text-right font-mono">
                      {formatMoney(r.outstandingBalance)}
                    </td>
                    <td className="py-2 px-2 text-right">{r.installmentsOverdue}</td>
                    <td className="py-2 px-2 text-right">{r.daysOverdue}</td>
                    <td className="py-2 px-2">
                      <Badge variant={bucketVariant(r.bucket)}>{BUCKET_LABELS[r.bucket]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-white/10 bg-white/[0.02] font-semibold">
                  <td className="py-2 px-2" colSpan={2}>Total</td>
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

function bucketVariant(b: AgingBucket): 'success' | 'danger' | 'muted' | 'warning' {
  switch (b) {
    case 'CURRENT': return 'success';
    case 'D_1_30': return 'warning';
    case 'D_31_60':
    case 'D_61_90': return 'warning';
    case 'D_90_PLUS': return 'danger';
    default: return 'muted';
  }
}
