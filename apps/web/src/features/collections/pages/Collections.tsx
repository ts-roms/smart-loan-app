import {
  useAccrueLateFees,
  useAssignableCollectors,
  useBulkAssignAccounts,
  useMyPermissions,
  useOverdueQueue,
} from "@loan/api-client";
import type { OverdueRow, QueueScope } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { MapPin, PhoneCall, RotateCw, UserCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
 * The queue is derived, so nothing here creates work — it surfaces it.
 * What a supervisor DOES here is hand it out: filter by the borrower's
 * area (province → city), tick the rows — or all of them — and assign
 * the lot to one collector. Area is the practical routing key for field
 * collection: the collector who covers Bulacan gets everything overdue
 * in Bulacan, in one action instead of fifty.
 *
 * Filtering is client-side over the loaded queue, deliberately: the
 * endpoint already returns the whole derived worklist (it has no
 * pagination), so a server round-trip per filter change would buy
 * nothing. If the book ever outgrows one response, the filter moves
 * server-side with it.
 *
 * The "Accrue late fees" button runs the daily job: posts the *delta*
 * between what the policy says should be on the books today and what's
 * already been accrued. Idempotent — safe to hit multiple times per day.
 */
export function CollectionsPage() {
  const [scope, setScope] = useState<QueueScope>("all");
  const queue = useOverdueQueue(scope);
  const accrue = useAccrueLateFees();
  const toast = useToast();
  const { user } = useAuth();
  const canAccrue = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";

  // Assignment is gated on the real permission, not the role enum — a
  // custom supervisor role built at /roles gets the checkboxes too.
  const myPerms = useMyPermissions();
  const canAssign = myPerms.data?.permissions.includes("collections.assign");

  const [province, setProvince] = useState("ALL");
  const [city, setCity] = useState("ALL");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [assigning, setAssigning] = useState(false);

  const rows = useMemo(() => queue.data ?? [], [queue.data]);

  // Filter options come from the data on screen, so the dropdowns never
  // offer an area with nothing overdue in it. "—" buckets rows whose
  // customer has no province recorded (city is required, province isn't).
  const provinces = useMemo(
    () =>
      [...new Set(rows.map((r) => r.customerProvince ?? "—"))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [rows],
  );
  const cities = useMemo(
    () =>
      [
        ...new Set(
          rows
            .filter(
              (r) =>
                province === "ALL" || (r.customerProvince ?? "—") === province,
            )
            .map((r) => r.customerCity),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [rows, province],
  );

  const visible = useMemo(
    () =>
      rows.filter(
        (r) =>
          (province === "ALL" || (r.customerProvince ?? "—") === province) &&
          (city === "ALL" || r.customerCity === city),
      ),
    [rows, province, city],
  );

  // A narrower province can orphan the chosen city; reset rather than
  // silently filtering on a city that's no longer offered.
  useEffect(() => {
    setCity("ALL");
  }, [province]);

  // Selection only ever means "these visible rows" — changing the filter
  // or scope silently keeping off-screen rows selected is how a
  // supervisor assigns Bulacan and quietly reassigns half of Cavite too.
  useEffect(() => {
    setSelected(new Set());
  }, [province, city, scope]);

  const allVisibleSelected =
    visible.length > 0 && visible.every((r) => selected.has(r.id));

  const toggleAll = () => {
    setSelected(
      allVisibleSelected ? new Set() : new Set(visible.map((r) => r.id)),
    );
  };
  const toggleOne = (id: string) => {
    setSelected((curr) => {
      const next = new Set(curr);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
      <CardContent className="space-y-3">
        {/* Area + scope filters. Scope narrows server-side (the endpoint
            never assembles a collector's view client-side); area narrows
            what's on screen. */}
        <div className="flex flex-wrap items-center gap-2">
          <MapPin className="h-4 w-4 text-fg-subtle" />
          <Select value={province} onValueChange={setProvince}>
            <SelectTrigger className="w-44" aria-label="Filter by province">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All provinces</SelectItem>
              {provinces.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={city} onValueChange={setCity}>
            <SelectTrigger className="w-44" aria-label="Filter by city">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All cities</SelectItem>
              {cities.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={scope}
            onValueChange={(v) => setScope(v as QueueScope)}
          >
            <SelectTrigger className="w-40" aria-label="Queue scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              <SelectItem value="mine">My accounts</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-fg-muted ml-auto">
            {visible.length} of {rows.length} account
            {rows.length === 1 ? "" : "s"}
          </span>
        </div>

        {/* Bulk-assign action bar — appears with a selection. */}
        {canAssign && selected.size > 0 && (
          <div className="flex items-center justify-between rounded-md border border-sky-400/30 bg-sky-500/[0.06] px-3 py-2">
            <span className="text-sm">
              {selected.size} account{selected.size === 1 ? "" : "s"} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
              <Button size="sm" onClick={() => setAssigning(true)}>
                <UserCheck className="h-3.5 w-3.5" />
                Assign to collector…
              </Button>
            </div>
          </div>
        )}

        {queue.isLoading ? (
          <SkeletonCard />
        ) : rows.length === 0 ? (
          <p className="text-sm text-success">No overdue loans. </p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No overdue accounts in that area.
          </p>
        ) : (
          <table className="w-full text-sm" data-tour="collections-table">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                {canAssign && (
                  <th className="py-2 px-2 w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all shown accounts"
                      checked={allVisibleSelected}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th className="py-2 px-2">Loan</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2">Customer</th>
                <th className="py-2 px-2">Area</th>
                <th className="py-2 px-2">Assignee</th>
                <th className="py-2 px-2 text-right">Outstanding</th>
                <th className="py-2 px-2 text-right">Overdue</th>
                <th className="py-2 px-2 text-right">Days</th>
                <th className="py-2 px-2">Severity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {visible.map((l) => (
                <tr key={l.id} className="hover:bg-hover">
                  {canAssign && (
                    <td className="py-2 px-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${l.number}`}
                        checked={selected.has(l.id)}
                        onChange={() => toggleOne(l.id)}
                      />
                    </td>
                  )}
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
                  <td className="py-2 px-2 text-xs text-fg-muted">
                    {l.customerCity}
                    {l.customerProvince ? `, ${l.customerProvince}` : ""}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    {l.assignee ? (
                      <span title={l.assignee.note ?? undefined}>
                        {l.assignee.collectorName}
                      </span>
                    ) : (
                      <span className="text-fg-subtle">Unassigned</span>
                    )}
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

      {assigning && (
        <BulkAssignDialog
          rows={visible.filter((r) => selected.has(r.id))}
          onClose={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false);
            setSelected(new Set());
          }}
        />
      )}
    </Card>
  );
}

/**
 * Pick a collector, confirm, done. The account list is echoed so the
 * supervisor confirms *what* they're handing over, not just how many —
 * and reassignments are called out, since bulk assign overwrites the
 * current owner.
 */
function BulkAssignDialog({
  rows,
  onClose,
  onDone,
}: {
  rows: OverdueRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const collectors = useAssignableCollectors();
  const bulkAssign = useBulkAssignAccounts();
  const toast = useToast();
  const [collectorId, setCollectorId] = useState("");
  const [note, setNote] = useState("");

  const reassignments = rows.filter((r) => r.assignee).length;
  const totalOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);

  const onSubmit = async () => {
    if (!collectorId) return;
    try {
      const result = await bulkAssign.mutateAsync({
        loanIds: rows.map((r) => r.id),
        collector: collectorId,
        note: note.trim() || undefined,
      });
      toast.success(
        `${result.assigned} account${result.assigned === 1 ? "" : "s"} assigned` +
          (result.missing.length > 0
            ? ` · ${result.missing.length} no longer exist`
            : ""),
      );
      onDone();
    } catch (err) {
      toast.error((err as Error).message ?? "Assignment failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-4 w-4" />
            Assign {rows.length} account{rows.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-xs text-fg-muted">
            Total outstanding:{" "}
            <span className="font-mono text-fg">
              {formatMoney(totalOutstanding)}
            </span>
            {reassignments > 0 && (
              <span className="text-warning">
                {" "}
                · {reassignments} already assigned — they will move to the new
                collector
              </span>
            )}
          </div>
          <div className="max-h-32 overflow-y-auto rounded border border-default bg-surface-2 p-2 text-xs font-mono space-y-0.5">
            {rows.map((r) => (
              <div key={r.id} className="flex justify-between gap-2">
                <span>
                  {r.number} · {r.customerName}
                </span>
                <span className="text-fg-subtle">{r.customerCity}</span>
              </div>
            ))}
          </div>
          <Select value={collectorId} onValueChange={setCollectorId}>
            <SelectTrigger aria-label="Collector">
              <SelectValue placeholder="Select a collector" />
            </SelectTrigger>
            <SelectContent>
              {(collectors.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Handover note (optional) — applied to every account"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={onSubmit}
              disabled={!collectorId || bulkAssign.isPending}
            >
              {bulkAssign.isPending
                ? "Assigning…"
                : `Assign ${rows.length} account${rows.length === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
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
