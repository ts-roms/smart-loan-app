import {
  usePortalContributions,
  usePortalMemberLedger,
} from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { Download, HandCoins } from "lucide-react";

import { downloadAuthedCsv } from "../lib/download-csv";

/**
 * Member's own contribution history (Capital Build-Up / Mortuary /
 * Emergency). Lifetime totals shown up top, then the per-transaction
 * breakdown. Read-only — contributions are recorded by an officer when
 * the member pays at the branch.
 */
export function PortalContributions() {
  const rows = usePortalContributions();
  const ledger = usePortalMemberLedger();

  const onDownload = () =>
    downloadAuthedCsv(
      "/api/v1/portal/contributions?format=csv",
      "my-contributions.csv",
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2">
            <HandCoins className="h-4 w-4 text-success" />
            My contributions
          </CardTitle>
          {(rows.data ?? []).length > 0 && (
            <Button size="sm" variant="outline" onClick={onDownload}>
              <Download className="h-3 w-3" />
              Download CSV
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {ledger.data && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
              <RollupCard
                label="Capital Build-Up"
                value={formatMoney(ledger.data.totals.capitalBuildUp)}
              />
              <RollupCard
                label="Mortuary Fund"
                value={formatMoney(ledger.data.totals.mortuaryFund)}
              />
              <RollupCard
                label="Emergency Fund"
                value={formatMoney(ledger.data.totals.emergencyFund)}
              />
            </div>
          )}
          {rows.isLoading ? (
            <SkeletonCard />
          ) : (rows.data ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">
              No contributions on record yet. Visit the branch to make your
              first contribution.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Date</th>
                  <th className="py-2 px-2 text-right">CBU</th>
                  <th className="py-2 px-2 text-right">Mortuary</th>
                  <th className="py-2 px-2 text-right">Emergency</th>
                  <th className="py-2 px-2 text-right">Total</th>
                  <th className="py-2 px-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {(rows.data ?? []).map((c) => {
                  const total =
                    Number(c.capitalBuildUp) +
                    Number(c.mortuaryFund) +
                    Number(c.emergencyFund);
                  return (
                    <tr key={c.id} className="hover:bg-hover">
                      <td className="py-2 px-2 text-xs text-fg-muted">
                        {formatDate(c.contributedAt)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {formatMoney(Number(c.capitalBuildUp))}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {formatMoney(Number(c.mortuaryFund))}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {formatMoney(Number(c.emergencyFund))}
                      </td>
                      <td className="py-2 px-2 text-right font-mono font-semibold">
                        {formatMoney(total)}
                      </td>
                      <td className="py-2 px-2 text-xs text-fg-muted max-w-xs truncate">
                        {c.notes ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RollupCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="text-base font-semibold font-mono text-success">
        {value}
      </div>
    </div>
  );
}
