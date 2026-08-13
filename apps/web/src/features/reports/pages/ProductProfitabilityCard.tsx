import { useProductProfitability } from "@loan/api-client";
import type { ProfitabilityFigures } from "@loan/shared-types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DatePicker,
  SkeletonCard,
} from "@loan/ui";
import { formatMoney, todayLocalISO } from "@loan/shared-utils";
import { useState } from "react";

const DAY_MS = 86_400_000;

/**
 * Product profitability (§54): per loan product over the period — what
 * it earned (interest, fees, late fees), what it lost (write-offs), and
 * the net. Amounts arrive as exact decimal strings; `formatMoney`
 * renders them without re-doing any arithmetic.
 *
 * Presented like the roll-rate card on the portfolio page: one table, a
 * period picker, a totals row.
 */
export function ProductProfitabilityCard() {
  const [from, setFrom] = useState(() =>
    todayLocalISO(new Date(Date.now() - 30 * DAY_MS)),
  );
  const [to, setTo] = useState(() => todayLocalISO());
  const report = useProductProfitability(from, to);

  const showUnattributed = (report.data?.unattributed.entryCount ?? 0) > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Product profitability</CardTitle>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-fg-muted">From</label>
          <DatePicker value={from} onChange={setFrom} className="h-9 w-40" />
          <label className="text-fg-muted">To</label>
          <DatePicker value={to} onChange={setTo} className="h-9 w-40" />
        </div>
      </CardHeader>
      <CardContent>
        {report.isLoading ? (
          <SkeletonCard />
        ) : report.isError || !report.data ? (
          <p className="text-sm text-fg-muted">
            Profitability data is unavailable — check the date range and that
            your role can read reports.
          </p>
        ) : report.data.products.length === 0 && !showUnattributed ? (
          <p className="text-sm text-fg-muted">
            No ledger activity on the income or write-off accounts in this
            window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Product</th>
                  <th className="py-2 px-2 text-right">Loans</th>
                  <th className="py-2 px-2 text-right">Interest</th>
                  <th className="py-2 px-2 text-right">Fees</th>
                  <th className="py-2 px-2 text-right">Late fees</th>
                  <th className="py-2 px-2 text-right">Write-offs</th>
                  <th className="py-2 px-2 text-right">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {report.data.products.map((p) => (
                  <tr key={p.productCode} className="hover:bg-hover">
                    <td className="py-2 px-2">
                      <span className="font-medium">{p.productName}</span>{" "}
                      <span className="text-xs text-fg-muted font-mono">
                        {p.productCode}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right">{p.loanCount}</td>
                    <FigureCells figures={p} />
                  </tr>
                ))}
                {showUnattributed && (
                  <tr className="hover:bg-hover">
                    <td className="py-2 px-2 text-fg-muted">
                      Unattributed
                      <span className="ml-1 text-xs">
                        ({report.data.unattributed.entryCount}{" "}
                        {report.data.unattributed.entryCount === 1
                          ? "entry"
                          : "entries"}
                        )
                      </span>
                    </td>
                    <td className="py-2 px-2 text-right text-fg-subtle">—</td>
                    <FigureCells figures={report.data.unattributed} />
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-default bg-surface-2 font-semibold">
                  <td className="py-2 px-2" colSpan={2}>
                    Total
                  </td>
                  <FigureCells figures={report.data.totals} />
                </tr>
              </tfoot>
            </table>
            <p className="mt-3 text-xs text-fg-subtle">
              Ledger-attributed figures only: interest (4000), fees and late
              fees (4100), write-off losses (5000), net of reversals and
              waivers. Cost of funds, operating costs, commissions and
              recoveries are out of scope — the ledger does not attribute them
              per product. Unattributed rows are income-account entries no loan
              claims.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FigureCells({ figures }: { figures: ProfitabilityFigures }) {
  return (
    <>
      <td className="py-2 px-2 text-right font-mono">
        {formatMoney(figures.interestIncome)}
      </td>
      <td className="py-2 px-2 text-right font-mono">
        {formatMoney(figures.feeIncome)}
      </td>
      <td className="py-2 px-2 text-right font-mono">
        {formatMoney(figures.lateFeeIncome)}
      </td>
      <td className="py-2 px-2 text-right font-mono">
        {formatMoney(figures.writeOffLoss)}
      </td>
      <td
        className={`py-2 px-2 text-right font-mono ${
          figures.net.startsWith("-") ? "text-danger" : ""
        }`}
      >
        {formatMoney(figures.net)}
      </td>
    </>
  );
}
