import { useAuditActions, useAuditEvents } from "@loan/api-client";
import type { AuditEventRow } from "@loan/shared-types";
import { formatDateTime } from "@loan/shared-utils";
import {
  Avatar,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
} from "@loan/ui";
import { ScrollText, Search } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The audit log, as a page.
 *
 * It used to be a navbar drawer showing the newest 100 with no way to
 * reach anything older — fine for "what just happened", useless for the
 * question an audit log exists to answer, which is "what happened on the
 * 14th, and who did it". A drawer is also the wrong shape for a table
 * you read across: actor, action, target and time all compete for the
 * same narrow column.
 *
 * Append-only and read-only. Entries are written by the routes that
 * perform the privileged actions, via `AuditLogRepository.record()`.
 */

/** Kept in step with the server's `AUDIT_PAGING.defaultPageSize`. */
const PAGE_SIZE = 25;

export function AuditLogPage() {
  const [actionFilter, setActionFilter] = useState("ALL");
  const [actorSearch, setActorSearch] = useState("");
  const [page, setPage] = useState(1);

  const actions = useAuditActions();
  const events = useAuditEvents({
    action: actionFilter === "ALL" ? undefined : actionFilter,
    page,
    pageSize: PAGE_SIZE,
  });

  /*
   * Narrowing the filter has to send you back to page 1. Staying on
   * page 7 of a result that now has two pages shows an empty table over
   * a real total, which reads as "nothing matched" when the truth is
   * "you are past the end".
   */
  useEffect(() => setPage(1), [actionFilter]);

  const data = events.data;
  const rows = data?.rows ?? [];

  /*
   * The actor search stays client-side, over the current page only, and
   * the readout below says so. Filtering a page in the browser and
   * captioning it with the server's total would claim a search of the
   * whole log — the one thing this screen must not get wrong. Give it a
   * server-side `actorId` filter when it needs to search properly.
   */
  const needle = actorSearch.trim().toLowerCase();
  const visible = needle
    ? rows.filter(
        (e) =>
          e.actorName?.toLowerCase().includes(needle) ||
          e.actorEmail?.toLowerCase().includes(needle),
      )
    : rows;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-info" />
          Audit log
        </CardTitle>
        <p className="text-xs text-fg-muted">
          Every privileged action, append-only. Entries cannot be edited or
          deleted.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:max-w-xl">
          <div>
            <Label>Action</Label>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All actions</SelectItem>
                {(actions.data ?? []).map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Actor on this page</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" />
              <Input
                value={actorSearch}
                onChange={(e) => setActorSearch(e.target.value)}
                placeholder="Name or email"
                className="pl-7"
              />
            </div>
          </div>
        </div>

        {events.isLoading ? (
          <SkeletonCard />
        ) : visible.length === 0 ? (
          <p className="py-8 text-center text-sm text-fg-muted">
            {needle
              ? "Nobody on this page matches that name. Clear it to see the page, or move through the pages."
              : "No events match the current filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2 font-medium">When</th>
                  <th className="py-2 px-2 font-medium">Actor</th>
                  <th className="py-2 px-2 font-medium">Action</th>
                  <th className="py-2 px-2 font-medium">Target</th>
                  <th className="py-2 px-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {visible.map((e) => (
                  <AuditRow key={e.id} event={e} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && (
          <>
            <Pagination
              page={data.page}
              totalPages={data.totalPages}
              total={data.total}
              pageSize={data.pageSize}
              onPageChange={setPage}
              noun="event"
            />
            {needle && (
              <p className="text-[11px] text-fg-subtle">
                Showing {visible.length} of {rows.length} on this page that
                match “{actorSearch.trim()}”. The count above is the whole log,
                unfiltered by name.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AuditRow({ event }: { event: AuditEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload =
    event.payload !== null &&
    event.payload !== undefined &&
    !(
      typeof event.payload === "object" &&
      Object.keys(event.payload).length === 0
    );

  return (
    <>
      <tr className="hover:bg-hover align-top">
        <td className="py-2 px-2 text-xs text-fg-muted whitespace-nowrap">
          {formatDateTime(event.createdAt)}
        </td>
        <td className="py-2 px-2">
          <div className="flex items-center gap-2">
            <Avatar
              name={event.actorName ?? event.actorEmail ?? "—"}
              size="sm"
            />
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">
                {event.actorName ?? event.actorEmail ?? "—"}
              </div>
              <div className="truncate text-[10px] text-fg-subtle">
                {event.actorEmail ?? "—"}
              </div>
            </div>
          </div>
        </td>
        <td className="py-2 px-2">
          <Badge variant="muted" className="font-mono text-[10px]">
            {event.action}
          </Badge>
        </td>
        <td className="py-2 px-2 font-mono text-[10px] text-fg-muted">
          {event.targetType ? (
            <>
              {event.targetType}
              {event.targetId ? (
                <span className="text-fg-subtle">
                  :{event.targetId.slice(0, 8)}…
                </span>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="py-2 px-2">
          {hasPayload ? (
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              className="text-[11px] text-info hover:underline"
            >
              {expanded ? "Hide" : "Show"}
            </button>
          ) : (
            <span className="text-[11px] text-fg-subtle">—</span>
          )}
        </td>
      </tr>
      {expanded && hasPayload && (
        <tr>
          <td colSpan={5} className="px-2 pb-2">
            <pre className="max-h-64 overflow-auto rounded bg-black/40 p-2 text-[10px] text-fg-muted">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
