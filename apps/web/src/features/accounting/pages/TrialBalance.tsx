import { useTrialBalance } from '@loan/api-client';
import { Badge, Card, CardContent, CardHeader, CardTitle, DatePicker, SkeletonCard } from '@loan/ui';
import { formatMoney } from '@loan/shared-utils';
import { useState } from 'react';

export function TrialBalancePage() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const trial = useTrialBalance(asOf);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Trial balance</CardTitle>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-white/55">As of</label>
          <DatePicker value={asOf} onChange={setAsOf} className="h-9 w-44" />
          {trial.data && (
            <Badge variant={trial.data.inBalance ? 'success' : 'danger'}>
              {trial.data.inBalance ? 'In balance' : 'Out of balance'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {trial.isLoading ? (
          <SkeletonCard />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Code</th>
                <th className="py-2 px-2">Account</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2 text-right">Debit</th>
                <th className="py-2 px-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(trial.data?.rows ?? []).map((r) => (
                <tr key={r.accountId} className="hover:bg-white/[0.03]">
                  <td className="py-2 px-2 font-mono">{r.code}</td>
                  <td className="py-2 px-2">{r.name}</td>
                  <td className="py-2 px-2 text-white/65">{r.type}</td>
                  <td className="py-2 px-2 text-right font-mono">
                    {r.debit > 0 ? formatMoney(r.debit) : ''}
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {r.credit > 0 ? formatMoney(r.credit) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/15 bg-white/[0.03] font-semibold">
                <td className="py-2 px-2" />
                <td className="py-2 px-2">Total</td>
                <td className="py-2 px-2" />
                <td className="py-2 px-2 text-right font-mono">
                  {formatMoney(trial.data?.totalDebit ?? 0)}
                </td>
                <td className="py-2 px-2 text-right font-mono">
                  {formatMoney(trial.data?.totalCredit ?? 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
