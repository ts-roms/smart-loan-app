import { usePortalMemberLedger, usePortalSavings } from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { Download, PiggyBank } from "lucide-react";

import { downloadAuthedCsv } from "../lib/download-csv";

/**
 * Member's own savings transaction history. Read-only — only officers
 * can record new transactions (the cash actually moves at the branch).
 * Lifetime totals come from the member-ledger endpoint so the math
 * lines up exactly with the officer-side ledger drawer.
 */
export function PortalSavings() {
  const txns = usePortalSavings();
  const ledger = usePortalMemberLedger();

  const onDownload = () =>
    downloadAuthedCsv("/api/v1/portal/savings?format=csv", "my-savings.csv");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2">
            <PiggyBank className="h-4 w-4 text-info" />
            My savings
          </CardTitle>
          {(txns.data ?? []).length > 0 && (
            <Button size="sm" variant="outline" onClick={onDownload}>
              <Download className="h-3 w-3" />
              Download CSV
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {/* Lifetime rollup row — deposits, withdrawals, net balance */}
          {ledger.data && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
              <RollupCard
                label="Lifetime deposits"
                value={formatMoney(ledger.data.totals.savingsDeposits)}
                tone="info"
              />
              <RollupCard
                label="Lifetime withdrawals"
                value={formatMoney(ledger.data.totals.savingsWithdrawals)}
                tone="info"
              />
              <RollupCard
                label="Net balance"
                value={formatMoney(ledger.data.totals.savingsNet)}
                tone={ledger.data.totals.savingsNet >= 0 ? "good" : "bad"}
              />
            </div>
          )}
          {txns.isLoading ? (
            <SkeletonCard />
          ) : (txns.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">
              No savings transactions yet. Talk to an officer at the branch to
              make your first deposit.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Date</th>
                  <th className="py-2 px-2">Type</th>
                  <th className="py-2 px-2 text-right">Amount</th>
                  <th className="py-2 px-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {(txns.data ?? []).map((t) => (
                  <tr key={t.id} className="hover:bg-hover">
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDate(t.txnDate)}
                    </td>
                    <td className="py-2 px-2">
                      <Badge
                        variant={t.kind === "DEPOSIT" ? "success" : "muted"}
                      >
                        {t.kind}
                      </Badge>
                    </td>
                    <td
                      className={`py-2 px-2 text-right font-mono ${
                        t.kind === "DEPOSIT" ? "text-success" : "text-danger"
                      }`}
                    >
                      {t.kind === "DEPOSIT" ? "+" : "−"}
                      {formatMoney(Number(t.amount))}
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                      {t.notes ?? "—"}
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

function RollupCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "info" | "good" | "bad";
}) {
  const toneClass = {
    info: "text-fg",
    good: "text-success",
    bad: "text-danger",
  }[tone];
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className={`text-base font-semibold font-mono ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}
