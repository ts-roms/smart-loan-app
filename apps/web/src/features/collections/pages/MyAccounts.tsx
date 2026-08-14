import {
  useAssignAccount,
  useAssignableCollectors,
  useCollectorWorkload,
  useOverdueQueue,
  useUnassignAccount,
} from "@loan/api-client";
import type { OverdueRow, QueueScope } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatMoney } from "@loan/shared-utils";
import { Inbox, MapPin, UserPlus, Users, X } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

// Direct import (not via ../../customers barrel) to avoid Rollup's
// cross-chunk circular-dep warning — see the note in Collections.tsx.
import { usePermission } from "../../../hooks/use-permission";
import { CustomerSummaryLink } from "../../customers/components/CustomerSummaryDrawer";
import { CollectionsCaseLink } from "../components/CollectionsCaseDrawer";

/**
 * Aging buckets, in days past due on the oldest unpaid installment.
 *
 * Standard 30-day bands. `max: null` is the open-ended tail rather than
 * a large sentinel, so nothing silently falls out of the last bucket.
 */
const BUCKETS: ReadonlyArray<{
  label: string;
  min: number;
  max: number | null;
  tone: "muted" | "warning" | "danger";
}> = [
  { label: "1–30", min: 1, max: 30, tone: "muted" },
  { label: "31–60", min: 31, max: 60, tone: "warning" },
  { label: "61–90", min: 61, max: 90, tone: "warning" },
  { label: "90+", min: 91, max: null, tone: "danger" },
];

function bucketOf(days: number) {
  return BUCKETS.find(
    (b) => days >= b.min && (b.max === null || days <= b.max),
  );
}

function severityVariant(days: number): "muted" | "warning" | "danger" {
  return bucketOf(days)?.tone ?? "muted";
}

/**
 * Collector dashboard — the accounts one person is responsible for.
 *
 * The existing /collections page is the whole delinquent book, sorted
 * by days overdue. It works as a shared worklist and answers nothing
 * about ownership: a collector had to scan the entire list for the
 * names they recognised. This is the other view — what is mine, how bad
 * is it, and what should I call first.
 *
 * Supervisors (collections.assign) get two extra things on the same
 * page: the unassigned pool with an assign control, and everyone's
 * headcount. Deliberately the same page rather than a separate admin
 * screen — handing work out is a reaction to seeing the spread, and
 * splitting them means looking at two screens to make one decision.
 */
/** Rows per page. A collector works this list top-down, by hand. */
const PAGE_SIZE = 50;

export function MyAccountsPage() {
  const canAssign = usePermission("collections.assign");

  /*
   * Scope AND area live in the URL, not component state.
   *
   * "Here are the twelve accounts nobody owns in Bulacan" is a link a
   * supervisor sends to another supervisor, and the back button should
   * return you to the list you were looking at rather than snapping to
   * "mine". Unrecognised scope values fall back to "mine" instead of
   * being passed to the API — the server validates the enum too, but a
   * typo'd query string should show the collector their own work, not a
   * 400. A stale area value just shows an empty list with an area
   * message, which is honest.
   */
  const [params, setParams] = useSearchParams();
  const raw = params.get("scope");
  const scope: QueueScope =
    raw === "unassigned" || raw === "all" ? raw : "mine";
  const province = params.get("province") ?? "ALL";
  const city = params.get("city") ?? "ALL";
  // Page is in the URL for the same reason scope and area are: the list
  // a supervisor is looking at should survive a link and a back button.
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);

  // One updater, defaults omitted from the URL so the bare route stays
  // the canonical "my accounts" link. Changing province resets city —
  // the old city likely isn't in the new province.
  const update = (next: {
    scope?: QueueScope;
    province?: string;
    city?: string;
    page?: number;
  }) => {
    const merged = { scope, province, city, page: 1, ...next };
    const out: Record<string, string> = {};
    if (merged.scope !== "mine") out.scope = merged.scope;
    if (merged.province !== "ALL") out.province = merged.province;
    if (merged.city !== "ALL") out.city = merged.city;
    if (merged.page !== 1) out.page = String(merged.page);
    setParams(out, { replace: true });
  };
  // Any narrowing drops back to page 1 — `update` defaults `page` to 1,
  // so only an explicit page change carries one through. Staying on
  // page 4 of a result that now has one page reads as "nothing here".
  const setScope = (next: QueueScope) => update({ scope: next });
  const setProvince = (next: string) => update({ province: next, city: "ALL" });
  const setCity = (next: string) => update({ city: next });
  const setPage = (next: number) => update({ page: next });

  const queue = useOverdueQueue(scope, {
    province: province === "ALL" ? undefined : province,
    city: city === "ALL" ? undefined : city,
    page,
    pageSize: PAGE_SIZE,
  });

  /*
   * The server filters and pages; `rows` is already the right window.
   *
   * Area options come from `areas`, derived server-side over the whole
   * scope with the area filter NOT applied — a list built from the
   * current page would offer only the areas that happened to land on it.
   * Customers with no recorded province are no longer offered as a "—"
   * bucket (there is no such value to filter on server-side); they
   * appear under "All provinces".
   */
  const visible = useMemo(() => queue.data?.rows ?? [], [queue.data]);
  const total = queue.data?.total ?? 0;
  const provinces = queue.data?.areas.provinces ?? [];
  const cities = queue.data?.areas.cities ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Inbox className="h-4 w-4" />
            {scope === "mine"
              ? "My accounts"
              : scope === "unassigned"
                ? "Unassigned accounts"
                : "All delinquent accounts"}
            {/* The whole filtered queue, not this page. */}
            <Badge variant="muted">{total}</Badge>
          </CardTitle>
          {/*
            Supervisors need to move between "what am I carrying" and
            "what is nobody carrying". A collector without
            collections.assign only ever has their own, so the switch
            would be three options with two dead ends.
          */}
          {canAssign && (
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as QueueScope)}
            >
              <SelectTrigger
                className="w-[200px]"
                aria-label="Which accounts to show"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">My accounts</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                <SelectItem value="all">Everyone&apos;s</SelectItem>
              </SelectContent>
            </Select>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Area filter — for a collector this is route planning ("what
              do I have in Malolos today"), for a supervisor it scopes the
              pool before handing it out. The aging summary below reflects
              the filtered view for the same reason. */}
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
            {(province !== "ALL" || city !== "ALL") && (
              <span className="text-xs text-fg-muted">
                {/* `total` is the filtered queue across all pages. */}
                {visible.length} of {total} account{total === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {queue.isLoading ? (
            <SkeletonCard />
          ) : (
            <>
              {/*
                AgingSummary folds the rows it is given, so on a paged
                queue it describes THIS PAGE and says so in its own
                heading. The unpaged whole-queue equivalent is the
                delinquency report, which is an export rather than a
                screen precisely because it is the whole book.
              */}
              <AgingSummary rows={visible} />
              <AccountsTable
                rows={visible}
                scope={scope}
                canAssign={canAssign}
                emptyMessage={
                  province !== "ALL" || city !== "ALL"
                    ? "No accounts in that area."
                    : scope === "mine"
                      ? "Nothing assigned to you. A supervisor hands accounts out from the unassigned pool."
                      : scope === "unassigned"
                        ? "Every delinquent account has an owner."
                        : "No delinquent accounts."
                }
              />
              {visible.length > 0 && (
                <Pagination
                  page={queue.data?.page ?? 1}
                  totalPages={queue.data?.totalPages ?? 1}
                  total={total}
                  pageSize={queue.data?.pageSize ?? PAGE_SIZE}
                  onPageChange={setPage}
                  noun="account"
                  busy={queue.isFetching}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>

      {canAssign && <WorkloadPanel />}
    </div>
  );
}

/**
 * Aging buckets plus the totals. Counts AND money, because ten accounts
 * one month late and one account a year late are very different
 * problems and a headcount alone hides which one you have.
 *
 * Folds whatever rows it is handed, which since the queue was paginated
 * means THIS PAGE. The labels say so rather than implying a whole-book
 * figure: an "Outstanding" that silently meant "outstanding on the
 * fifty accounts currently on screen" is exactly the kind of number
 * someone quotes in a meeting. The whole-book equivalents are the aging
 * report (§28 bands, every loan) and the delinquency export.
 */
function AgingSummary({ rows }: { rows: OverdueRow[] }) {
  if (rows.length === 0) return null;

  const totalOutstanding = rows.reduce((s, r) => s + Number(r.outstanding), 0);
  const worst = rows.reduce((m, r) => Math.max(m, r.daysOverdue), 0);

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Accounts on this page" value={String(rows.length)} />
        <Stat
          label="Outstanding on this page"
          value={formatMoney(totalOutstanding)}
        />
        <Stat label="Worst on this page" value={`${worst} days`} />
      </dl>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BUCKETS.map((b) => {
          const inBucket = rows.filter(
            (r) =>
              r.daysOverdue >= b.min &&
              (b.max === null || r.daysOverdue <= b.max),
          );
          const sum = inBucket.reduce((s, r) => s + Number(r.outstanding), 0);
          return (
            <div
              key={b.label}
              className="rounded-md border border-default bg-surface-2 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-fg-subtle">
                  {b.label} days
                </span>
                <Badge variant={b.tone}>{inBucket.length}</Badge>
              </div>
              <div className="mt-1 font-mono text-sm">
                {inBucket.length > 0 ? formatMoney(sum) : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-fg-subtle">
        {label}
      </dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}

function AccountsTable({
  rows,
  scope,
  canAssign,
  emptyMessage,
}: {
  rows: OverdueRow[];
  scope: QueueScope;
  canAssign: boolean;
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-muted">{emptyMessage}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-2 px-2">Loan</th>
            <th className="py-2 px-2">Customer</th>
            <th className="py-2 px-2">Area</th>
            <th className="py-2 px-2 text-right">Outstanding</th>
            <th className="py-2 px-2 text-right">Days</th>
            <th className="py-2 px-2">Aging</th>
            {/* Who holds it is noise on "mine" — they all hold the same. */}
            {scope !== "mine" && <th className="py-2 px-2">Assigned to</th>}
            {canAssign && <th className="py-2 px-2 text-right">Assign</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {rows.map((r) => (
            <tr key={r.id} className="hover:bg-hover">
              <td className="py-1.5 px-2 font-mono text-xs">
                <CollectionsCaseLink id={r.id}>{r.number}</CollectionsCaseLink>
              </td>
              <td className="py-1.5 px-2">
                <CustomerSummaryLink customerId={r.customerId}>
                  {r.customerName}
                </CustomerSummaryLink>
              </td>
              <td className="py-1.5 px-2 text-xs text-fg-muted">
                {r.customerCity}
                {r.customerProvince ? `, ${r.customerProvince}` : ""}
              </td>
              <td className="py-1.5 px-2 text-right font-mono">
                {formatMoney(Number(r.outstanding))}
              </td>
              <td className="py-1.5 px-2 text-right font-mono text-xs">
                {r.daysOverdue}
              </td>
              <td className="py-1.5 px-2">
                <Badge variant={severityVariant(r.daysOverdue)}>
                  {bucketOf(r.daysOverdue)?.label ?? "—"}
                </Badge>
              </td>
              {scope !== "mine" && (
                <td className="py-1.5 px-2 text-xs">
                  {r.assignee ? (
                    r.assignee.collectorName
                  ) : (
                    <span className="text-fg-subtle">Unassigned</span>
                  )}
                </td>
              )}
              {canAssign && (
                <td className="py-1.5 px-2 text-right">
                  <AssignControl row={r} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Assign / reassign / release a single account.
 *
 * The picker writes immediately on select rather than staging a change
 * behind a Save. Handing out accounts is a rapid, repetitive action and
 * a confirm step on each one is friction with no safety payoff —
 * reassignment is a single click to undo and nothing is destroyed.
 */
function AssignControl({ row }: { row: OverdueRow }) {
  const collectors = useAssignableCollectors();
  const assign = useAssignAccount();
  const unassign = useUnassignAccount();
  const toast = useToast();

  const onPick = async (collectorId: string) => {
    try {
      await assign.mutateAsync({ loanId: row.id, collector: collectorId });
      const name =
        collectors.data?.find((c) => c.id === collectorId)?.name ?? "collector";
      toast.success(`${row.number} → ${name}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not assign");
    }
  };

  const onRelease = async () => {
    try {
      await unassign.mutateAsync(row.id);
      toast.success(`${row.number} returned to the pool`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not unassign");
    }
  };

  const busy = assign.isPending || unassign.isPending;

  return (
    <div className="inline-flex items-center gap-1">
      <Select
        // Keyed by the current owner so the trigger reflects reality
        // after a reassignment lands, instead of holding the stale
        // selection the user just replaced.
        key={row.assignee?.collectorId ?? "none"}
        value={row.assignee?.collectorId ?? ""}
        onValueChange={onPick}
        disabled={busy}
      >
        <SelectTrigger
          className="h-7 w-[150px] text-xs"
          // Four of these sit in a column with nothing to tell them
          // apart: the visible text is the owner's name (or "Assign"),
          // never the account. Without this a screen reader announces
          // four identical comboboxes.
          aria-label={
            row.assignee
              ? `Reassign ${row.number}, currently ${row.assignee.collectorName}`
              : `Assign ${row.number} to a collector`
          }
        >
          <SelectValue
            placeholder={
              <span className="inline-flex items-center gap-1 text-fg-subtle">
                <UserPlus className="h-3 w-3" />
                Assign
              </span>
            }
          />
        </SelectTrigger>
        <SelectContent>
          {(collectors.data ?? []).map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {row.assignee && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRelease}
          disabled={busy}
          aria-label={`Return ${row.number} to the unassigned pool`}
          title="Return to the unassigned pool"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

/**
 * Who is carrying how much. Counts every account a collector holds, not
 * just the currently-delinquent ones — an account that cured keeps its
 * owner, and "how many is this person responsible for" is the question
 * someone about to hand out more work is actually asking.
 */
function WorkloadPanel() {
  const workload = useCollectorWorkload();
  const rows = workload.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="h-4 w-4" />
          Workload
        </CardTitle>
      </CardHeader>
      <CardContent>
        {workload.isLoading ? (
          <SkeletonCard />
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No accounts are assigned yet.</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((w) => (
              <li
                key={w.collectorId}
                className="flex items-center justify-between text-sm"
              >
                <span>{w.collectorName}</span>
                <Badge variant="muted">
                  {w.accounts} {w.accounts === 1 ? "account" : "accounts"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
