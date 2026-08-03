import {
  useAccrueInterest,
  useClosePeriod,
  usePeriods,
  useReopenPeriod,
} from "@loan/api-client";
import type { AccountingPeriod } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import { CalendarCheck, Lock, LockOpen, RotateCw } from "lucide-react";
import { useMemo } from "react";

import { useAuth } from "../../../providers/auth";

/**
 * Accounting periods. Each month is a row; once CLOSED no postings can
 * hit it (including auto-posts from loan disburse/payment if their
 * entryDate falls inside). Admin can reopen; accountant can close.
 *
 * Also exposes the monthly interest accrual job — idempotent, so the
 * "Accrue this month" button can be hit before close-out without harm.
 */
export function PeriodsPage() {
  const periods = usePeriods();
  const close = useClosePeriod();
  const reopen = useReopenPeriod();
  const accrue = useAccrueInterest();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canClose = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";
  const canReopen = user?.role === "ADMIN";

  const sorted = useMemo(() => {
    return [...(periods.data ?? [])].sort(
      (a, b) => b.year - a.year || b.month - a.month,
    );
  }, [periods.data]);

  const onClose = async (p: { year: number; month: number }) => {
    const ok = await confirm({
      title: `Close ${labelFor(p)}?`,
      message:
        "No more postings can hit this period until an admin reopens it. Loan disburse / payment auto-posts dated inside this period will be blocked.",
      confirmLabel: "Close period",
    });
    if (!ok) return;
    try {
      await close.mutateAsync(p);
      toast.success(`${labelFor(p)} closed`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to close");
    }
  };

  const onReopen = async (p: { year: number; month: number }) => {
    const ok = await confirm({
      title: `Reopen ${labelFor(p)}?`,
      message: "New postings will be allowed in this period again.",
      confirmLabel: "Reopen",
    });
    if (!ok) return;
    try {
      await reopen.mutateAsync(p);
      toast.success(`${labelFor(p)} reopened`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to reopen");
    }
  };

  const onAccrue = async () => {
    try {
      const r = await accrue.mutateAsync({});
      toast.success(`Accrual: ${r.posted} posted, ${r.skipped} skipped`);
    } catch (err) {
      toast.error((err as Error).message ?? "Accrual failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="h-4 w-4" />
          Accounting periods
        </CardTitle>
        {canClose && (
          <Button
            variant="outline"
            onClick={onAccrue}
            disabled={accrue.isPending}
          >
            <RotateCw className="h-4 w-4" />
            {accrue.isPending ? "Accruing…" : "Accrue this month"}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {periods.isLoading ? (
          <SkeletonCard />
        ) : sorted.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No periods yet. They auto-create the first time a journal entry hits
            a new month.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Period</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Closed at</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {sorted.map((p) => (
                <PeriodRow
                  key={p.id}
                  period={p}
                  canClose={canClose}
                  canReopen={canReopen}
                  closing={close.isPending}
                  reopening={reopen.isPending}
                  onClose={() => onClose(p)}
                  onReopen={() => onReopen(p)}
                />
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function PeriodRow({
  period,
  canClose,
  canReopen,
  closing,
  reopening,
  onClose,
  onReopen,
}: {
  period: AccountingPeriod;
  canClose: boolean;
  canReopen: boolean;
  closing: boolean;
  reopening: boolean;
  onClose: () => void;
  onReopen: () => void;
}) {
  return (
    <tr className="hover:bg-hover">
      <td className="py-2 px-2 font-mono">{labelFor(period)}</td>
      <td className="py-2 px-2">
        <Badge variant={period.status === "CLOSED" ? "muted" : "success"}>
          {period.status}
        </Badge>
      </td>
      <td className="py-2 px-2 text-xs text-fg-muted">
        {period.closedAt ? formatDate(period.closedAt) : "—"}
      </td>
      <td className="py-2 px-2 text-right">
        {period.status === "OPEN" && canClose && (
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            disabled={closing}
          >
            <Lock className="h-3 w-3" />
            Close
          </Button>
        )}
        {period.status === "CLOSED" && canReopen && (
          <Button
            size="sm"
            variant="outline"
            onClick={onReopen}
            disabled={reopening}
          >
            <LockOpen className="h-3 w-3" />
            Reopen
          </Button>
        )}
      </td>
    </tr>
  );
}

function labelFor(p: { year: number; month: number }): string {
  const date = new Date(p.year, p.month - 1, 1);
  return date.toLocaleString("en-PH", { month: "long", year: "numeric" });
}
