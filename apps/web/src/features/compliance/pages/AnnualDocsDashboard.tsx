import {
  useExpiringAnnualDocs,
  useRefreshAnnualDocStatuses,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import { FileWarning, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { findArticle, TourButton } from "../../help";

const TYPE_LABELS: Record<string, string> = {
  CAR_INSURANCE: "Car insurance",
  OR_CR: "OR / CR",
  RPT: "Real property tax",
  FIRE_INSURANCE: "Fire insurance",
  OTHER: "Other",
};

const WINDOW_OPTIONS = [
  { value: 7, label: "Next 7 days" },
  { value: 30, label: "Next 30 days" },
  { value: 60, label: "Next 60 days" },
  { value: 90, label: "Next 90 days" },
];

/**
 * AnnualDocsDashboard — cross-loan view of renewable documents expiring
 * soon (FRD §3.8.1 reporting requirement). Filter by horizon, group by
 * status, and trigger a manual status refresh on demand.
 */
export function AnnualDocsDashboard() {
  const [days, setDays] = useState(30);
  const expiring = useExpiringAnnualDocs(days);
  const refresh = useRefreshAnnualDocStatuses();
  const toast = useToast();

  const onRefresh = async () => {
    try {
      const r = await refresh.mutateAsync();
      toast.success(
        `Refreshed · Valid ${r.valid} · Expiring ${r.expiringSoon} · Expired ${r.expired}`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Refresh failed");
    }
  };

  const rows = expiring.data ?? [];
  const expired = rows.filter((r) => r.status === "EXPIRED");
  const expiringSoon = rows.filter((r) => r.status === "EXPIRING_SOON");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-sky-300" />
            Renewable documents
          </CardTitle>
          <div className="flex items-center gap-2">
            <TourButton
              tourId="annual-docs"
              steps={findArticle("annual-docs")?.tour ?? []}
            />
            <select
              data-tour="annualdocs-window"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="text-xs bg-white/[0.04] border border-white/15 rounded-md px-2 py-1"
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span data-tour="annualdocs-refresh">
              <Button
                size="sm"
                variant="outline"
                onClick={onRefresh}
                disabled={refresh.isPending}
              >
                <RefreshCw
                  className={
                    refresh.isPending ? "h-3 w-3 animate-spin" : "h-3 w-3"
                  }
                />
                Refresh statuses
              </Button>
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/55">
            FRD §3.8 — every loan's annual / renewable documentation tracked
            here. The daily job sends reminders 30 days before expiry and an
            escalation when a doc lapses.
          </p>
        </CardContent>
      </Card>

      {expiring.isLoading ? (
        <SkeletonCard />
      ) : (
        <>
          {expired.length > 0 && (
            <DocsCard
              title="Expired"
              icon={<FileWarning className="h-4 w-4 text-rose-300" />}
              rows={expired}
              accent="rose"
            />
          )}
          <DocsCard
            title={`Expiring within ${days} days`}
            icon={<ShieldCheck className="h-4 w-4 text-amber-300" />}
            rows={expiringSoon}
            accent="amber"
          />
        </>
      )}
    </div>
  );
}

function DocsCard({
  title,
  icon,
  rows,
  accent,
}: {
  title: string;
  icon: React.ReactNode;
  rows: import("@loan/shared-types").ExpiringAnnualDocument[];
  accent: "rose" | "amber";
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title} ({rows.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-white/55">Nothing here — good standing.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Loan</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Document</th>
                <th className="py-2 px-2">Expires</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Reminders</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.03]">
                  <td className="py-2 px-2 font-mono text-xs">
                    <Link
                      to={`/loans/${r.loan.number}`}
                      className="text-sky-300 hover:underline"
                    >
                      {r.loan.number}
                    </Link>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant="muted">
                      {TYPE_LABELS[r.type] ?? r.type}
                    </Badge>
                  </td>
                  <td className="py-2 px-2">{r.name}</td>
                  <td className="py-2 px-2 text-xs">
                    {formatDate(r.expiresAt)}
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant={accent === "rose" ? "danger" : "warning"}>
                      {r.status === "EXPIRED" ? "Expired" : "Expiring soon"}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-xs text-white/55">
                    {r.reminderCount > 0 ? `${r.reminderCount} sent` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
