import type { LeaseAgreementWithLoan, LeaseStatus } from "@loan/shared-types";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
} from "@loan/ui";
import { formatDateTime, formatMoney } from "@loan/shared-utils";
import { Car } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useLeases } from "../hooks";
import { STATUS_LABEL, STATUS_VARIANT, TITLE_HOLDER_LABEL } from "../constants";

/**
 * Lease-to-Own queue cross-loan view.
 *
 * Read-only list. State transitions (buyout / pull-out / return / extend)
 * happen on the per-loan detail page via `LeasePanel`, so this page
 * just routes the operator to the right loan. A status filter keeps the
 * view scoped to whatever phase the user cares about
 * (ACTIVE for monitoring, PULLED_OUT for the recovery follow-up,
 * BUYOUT_COMPLETED / RETURNED / EXTENDED for the audit trail).
 */
export function LeaseQueuePage() {
  const [statusFilter, setStatusFilter] = useState<LeaseStatus | "ALL">("ALL");
  const leases = useLeases(statusFilter === "ALL" ? undefined : statusFilter);

  // Counts-by-status — render even while the filtered query is in flight
  // by computing from the full list when "ALL" is selected. When a filter
  // is active, the unfiltered counts would require a second query, which
  // isn't worth it; we just hide the count card.
  const counts = useMemo(() => {
    if (statusFilter !== "ALL" || !leases.data) return null;
    const init: Record<LeaseStatus, number> = {
      ACTIVE: 0,
      PULLED_OUT: 0,
      BUYOUT_COMPLETED: 0,
      RETURNED: 0,
      EXTENDED: 0,
    };
    for (const a of leases.data) init[a.status] += 1;
    return init;
  }, [leases.data, statusFilter]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Car className="h-4 w-4 text-sky-300" />
            Lease-to-Own
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/55">
            agreements are created automatically when a lease-product loan is
            disbursed. Operators monitor active units, follow up on pull-outs,
            and close out via buyout, return, or extension. State transitions
            happen on the loan detail page; this view is for at-a-glance triage.
          </p>
        </CardContent>
      </Card>

      {counts && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
          {(Object.keys(counts) as LeaseStatus[]).map((s) => (
            <Card key={s}>
              <CardContent className="py-3">
                <div className="text-xs text-white/55">{STATUS_LABEL[s]}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {counts[s]}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Agreements</CardTitle>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as LeaseStatus | "ALL")}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {(Object.keys(STATUS_LABEL) as LeaseStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {leases.isLoading ? (
            <SkeletonCard />
          ) : (leases.data ?? []).length === 0 ? (
            <p className="text-sm text-white/55">
              No lease agreements at this status.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                <tr>
                  <th className="py-2 px-2">Loan</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2 text-right">Residual</th>
                  <th className="py-2 px-2">Title holder</th>
                  <th className="py-2 px-2 text-right">Missed</th>
                  <th className="py-2 px-2">Closed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {leases.data!.map((a) => (
                  <LeaseRow key={a.id} a={a} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LeaseRow({ a }: { a: LeaseAgreementWithLoan }) {
  // `closedAt` is set when the agreement reached a terminal state; for
  // ACTIVE rows we render an em-dash. Buyout has its own column-worthy
  // detail (the amount paid) but cramming it into this overview would
  // explode the row; users tap through to the loan detail for that.
  const closedLabel = a.closedAt
    ? formatDateTime(new Date(a.closedAt))
    : a.buyoutAt
      ? formatDateTime(new Date(a.buyoutAt))
      : a.pulledOutAt
        ? formatDateTime(new Date(a.pulledOutAt))
        : "—";

  return (
    <tr className="hover:bg-white/[0.03]">
      <td className="py-2 px-2 font-mono text-xs">
        <Link
          to={`/loans/${a.loan.number}`}
          className="text-sky-300 hover:underline"
        >
          {a.loan.number}
        </Link>
      </td>
      <td className="py-2 px-2">
        <Badge variant={STATUS_VARIANT[a.status]}>
          {STATUS_LABEL[a.status]}
        </Badge>
      </td>
      <td className="py-2 px-2 text-right tabular-nums">
        {formatMoney(Number(a.residualValue))}
      </td>
      <td className="py-2 px-2 text-xs text-white/70">
        {TITLE_HOLDER_LABEL[a.titleHolder]}
      </td>
      <td className="py-2 px-2 text-right tabular-nums">
        {a.missedPaymentStreak > 0 ? (
          <span
            className={
              a.missedPaymentStreak >= 3 ? "text-rose-300" : "text-amber-300"
            }
          >
            {a.missedPaymentStreak}
          </span>
        ) : (
          <span className="text-white/40">0</span>
        )}
      </td>
      <td className="py-2 px-2 text-xs text-white/70">{closedLabel}</td>
    </tr>
  );
}
