import { useBalanceSheet } from "@loan/api-client";
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

export function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const sheet = useBalanceSheet(asOf);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Balance sheet</CardTitle>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-fg-muted">As of</label>
          <DatePicker value={asOf} onChange={setAsOf} className="h-9 w-44" />
          {sheet.data && (
            <Badge variant={sheet.data.inBalance ? "success" : "danger"}>
              {sheet.data.inBalance ? "In balance" : "Out of balance"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {sheet.isLoading ? (
          <SkeletonCard />
        ) : !sheet.data ? (
          <p className="text-sm text-fg-muted">No data.</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Section
              title="Assets"
              rows={sheet.data.assets.rows}
              total={sheet.data.assets.total}
            />
            <div className="space-y-6">
              <Section
                title="Liabilities"
                rows={sheet.data.liabilities.rows}
                total={sheet.data.liabilities.total}
              />
              <div>
                <h3 className="text-xs uppercase tracking-wider text-fg-subtle mb-2">
                  Equity
                </h3>
                <ul className="divide-y divide-default text-sm">
                  {sheet.data.equity.rows.map((r) => (
                    <li key={r.code} className="flex justify-between py-1.5">
                      <span>
                        <span className="font-mono text-fg-muted mr-2">
                          {r.code}
                        </span>
                        {r.name}
                      </span>
                      <span className="font-mono">{formatMoney(r.amount)}</span>
                    </li>
                  ))}
                  <li className="flex justify-between py-1.5">
                    <span>Retained earnings</span>
                    <span className="font-mono">
                      {formatMoney(sheet.data.retainedEarnings)}
                    </span>
                  </li>
                  <li className="flex justify-between py-2 border-t border-default font-semibold mt-1">
                    <span>Total equity</span>
                    <span className="font-mono">
                      {formatMoney(
                        sheet.data.equity.total + sheet.data.retainedEarnings,
                      )}
                    </span>
                  </li>
                </ul>
              </div>
              <div className="border-t border-default pt-3 flex items-center justify-between font-semibold">
                <span>Total liabilities + equity</span>
                <span className="font-mono">
                  {formatMoney(sheet.data.totalLiabilitiesAndEquity)}
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  rows,
  total,
}: {
  title: string;
  rows: Array<{ code: string; name: string; amount: number }>;
  total: number;
}) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-fg-subtle mb-2">
        {title}
      </h3>
      <ul className="divide-y divide-default text-sm">
        {rows.length === 0 && (
          <li className="py-2 text-fg-subtle">No activity.</li>
        )}
        {rows.map((r) => (
          <li key={r.code} className="flex justify-between py-1.5">
            <span>
              <span className="font-mono text-fg-muted mr-2">{r.code}</span>
              {r.name}
            </span>
            <span className="font-mono">{formatMoney(r.amount)}</span>
          </li>
        ))}
        <li className="flex justify-between py-2 border-t border-default font-semibold mt-1">
          <span>Total {title.toLowerCase()}</span>
          <span className="font-mono">{formatMoney(total)}</span>
        </li>
      </ul>
    </div>
  );
}
