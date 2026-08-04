import { useTrialBalance } from "@loan/api-client";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  SkeletonCard,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { useState } from "react";

export function TrialBalancePage() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const trial = useTrialBalance(asOf);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Trial balance</CardTitle>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-fg-muted">As of</label>
          <DatePicker value={asOf} onChange={setAsOf} className="h-9 w-44" />
          {trial.data && (
            <Badge variant={trial.data.inBalance ? "success" : "danger"}>
              {trial.data.inBalance ? "In balance" : "Out of balance"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {trial.isLoading ? (
          <SkeletonCard />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Code</th>
                <th className="py-2 px-2">Account</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2 text-right">Debit</th>
                <th className="py-2 px-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(trial.data?.rows ?? []).map((r) => (
                <tr key={r.accountId} className="hover:bg-hover">
                  <td className="py-2 px-2 font-mono">{r.code}</td>
                  <td className="py-2 px-2">{r.name}</td>
                  <td className="py-2 px-2 text-fg-muted">{r.type}</td>
                  <td className="py-2 px-2 text-right font-mono">
                    {r.debit > 0 ? formatMoney(r.debit) : ""}
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {r.credit > 0 ? formatMoney(r.credit) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-default bg-surface-2 font-semibold">
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
