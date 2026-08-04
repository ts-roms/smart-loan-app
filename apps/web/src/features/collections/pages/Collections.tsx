import { useAccrueLateFees, useOverdueQueue } from "@loan/api-client";
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
import { formatMoney } from "@loan/shared-utils";
import { PhoneCall, RotateCw } from "lucide-react";

import { useAuth } from "../../../providers/auth";
// Direct import (not via ../../customers barrel) to avoid Rollup's
// cross-chunk circular-dep warning: each feature lazy-loads into its
// own chunk, and the customers barrel re-exporting a component that
// collections/kyc/etc. import would create a circular chunk graph.
import { CustomerSummaryLink } from "../../customers/components/CustomerSummaryDrawer";
import { CollectionsCaseLink } from "../components/CollectionsCaseDrawer";
import { findArticle, TourButton } from "../../help";

const TYPE_LABELS: Record<string, string> = {
  SALARY: "Salary",
  AUTOMOTIVE: "Auto",
  MOTORCYCLE: "Motorcycle",
  HOUSING: "Housing",
};

/**
 * Collections queue — every active loan with at least one unpaid installment
 * past its due date. Sorted by days overdue, deepest delinquency first.
 *
 * The "Accrue late fees" button runs the daily job: posts the *delta* between
 * what the policy says should be on the books today and what's already
 * been accrued. Idempotent — safe to hit multiple times per day.
 */
export function CollectionsPage() {
  const queue = useOverdueQueue();
  const accrue = useAccrueLateFees();
  const toast = useToast();
  const { user } = useAuth();
  const canAccrue = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";

  const onAccrue = async () => {
    try {
      const r = await accrue.mutateAsync();
      toast.success(`Late fees: ${r.posted} posted, ${r.skipped} skipped`);
    } catch (err) {
      toast.error((err as Error).message ?? "Accrual failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-warning" />
          Collections queue
        </CardTitle>
        <div className="flex items-center gap-2">
          <TourButton
            tourId="collections"
            steps={findArticle("collections")?.tour ?? []}
          />
          {canAccrue && (
            <Button
              variant="outline"
              onClick={onAccrue}
              disabled={accrue.isPending}
            >
              <RotateCw className="h-4 w-4" />
              {accrue.isPending ? "Accruing…" : "Accrue late fees"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {queue.isLoading ? (
          <SkeletonCard />
        ) : (queue.data ?? []).length === 0 ? (
          <p className="text-sm text-success">No overdue loans. </p>
        ) : (
          <table className="w-full text-sm" data-tour="collections-table">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Loan</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Customer</th>
                <th className="py-2 px-2 text-right">Outstanding</th>
                <th className="py-2 px-2 text-right">Overdue</th>
                <th className="py-2 px-2 text-right">Days</th>
                <th className="py-2 px-2">Severity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(queue.data ?? []).map((l) => (
                <tr key={l.id} className="hover:bg-hover">
                  <td className="py-2 px-2 font-mono">
                    <CollectionsCaseLink id={l.id}>
                      {l.number}
                    </CollectionsCaseLink>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant="muted">
                      {TYPE_LABELS[l.productCode] ?? l.productCode}
                    </Badge>
                  </td>
                  <td className="py-2 px-2">
                    <CustomerSummaryLink customerId={l.customerId}>
                      <span className="text-fg hover:text-info">
                        {l.customerName}
                      </span>
                    </CustomerSummaryLink>
                  </td>
                  <td className="py-2 px-2 text-right font-mono">
                    {formatMoney(l.outstanding)}
                  </td>
                  <td className="py-2 px-2 text-right">{l.overdueCount}</td>
                  <td className="py-2 px-2 text-right">{l.daysOverdue}</td>
                  <td className="py-2 px-2">
                    <Badge variant={severityVariant(l.daysOverdue)}>
                      {severityLabel(l.daysOverdue)}
                    </Badge>
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

function severityLabel(days: number): string {
  if (days <= 7) return "New";
  if (days <= 30) return "1–30 days";
  if (days <= 60) return "31–60 days";
  if (days <= 90) return "61–90 days";
  return "90+ days";
}

function severityVariant(
  days: number,
): "success" | "danger" | "muted" | "warning" {
  if (days <= 7) return "warning";
  if (days <= 60) return "warning";
  return "danger";
}
