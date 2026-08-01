import { useIncomeStatement } from "@loan/api-client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  SkeletonCard,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { useState } from "react";

export function IncomeStatementPage() {
  const today = new Date();
  const [from, setFrom] = useState(() =>
    new Date(today.getFullYear(), 0, 1).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(() => today.toISOString().slice(0, 10));
  const report = useIncomeStatement(from, to);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Income statement</CardTitle>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-white/55">From</label>
          <DatePicker
            value={from}
            onChange={setFrom}
            max={to}
            className="h-9 w-44"
          />
          <label className="text-white/55">To</label>
          <DatePicker
            value={to}
            onChange={setTo}
            min={from}
            className="h-9 w-44"
          />
        </div>
      </CardHeader>
      <CardContent>
        {report.isLoading ? (
          <SkeletonCard />
        ) : !report.data ? (
          <p className="text-sm text-white/55">No data.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Section
              title="Income"
              rows={report.data.income.rows}
              total={report.data.income.total}
              positive
            />
            <Section
              title="Expenses"
              rows={report.data.expense.rows}
              total={report.data.expense.total}
            />
            <div className="md:col-span-2 border-t border-white/10 pt-3 flex items-center justify-between">
              <div className="text-sm uppercase tracking-wider text-white/55">
                Net income
              </div>
              <div
                className={`text-xl font-semibold font-mono ${
                  report.data.netIncome >= 0
                    ? "text-emerald-300"
                    : "text-rose-300"
                }`}
              >
                {formatMoney(report.data.netIncome)}
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
  positive,
}: {
  title: string;
  rows: Array<{ code: string; name: string; amount: number }>;
  total: number;
  positive?: boolean;
}) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-white/45 mb-2">
        {title}
      </h3>
      <ul className="divide-y divide-white/5 text-sm">
        {rows.length === 0 && (
          <li className="py-2 text-white/45">No activity.</li>
        )}
        {rows.map((r) => (
          <li key={r.code} className="flex justify-between py-1.5">
            <span>
              <span className="font-mono text-white/55 mr-2">{r.code}</span>
              {r.name}
            </span>
            <span className="font-mono">{formatMoney(r.amount)}</span>
          </li>
        ))}
        <li className="flex justify-between py-2 border-t border-white/10 font-semibold mt-1">
          <span>Total {title.toLowerCase()}</span>
          <span className={`font-mono ${positive ? "text-emerald-300" : ""}`}>
            {formatMoney(total)}
          </span>
        </li>
      </ul>
    </div>
  );
}
