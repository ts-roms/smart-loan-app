import { useAuditActions, useAuditEvents, useMyPermissions } from '@loan/api-client';
import type { AuditEventRow } from '@loan/shared-types';
import {
  Avatar,
  Badge,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonLine,
} from '@loan/ui';
import { formatDateTime } from '@loan/shared-utils';
import { ScrollText, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Audit log navbar trigger + drawer. Shows the last N privileged actions,
 * filterable by action label and actor name (client-side substring). Gated
 * on `admin.audit_log` — if the current user doesn't have the permission
 * the trigger renders nothing.
 *
 * Append-only, read-only — actions are recorded by their owning routes via
 * AuditLogRepository.record().
 */
export function AuditLogTrigger() {
  const me = useMyPermissions();
  const allowed = (me.data?.permissions ?? []).includes('admin.audit_log');
  const [open, setOpen] = useState(false);

  if (!allowed) return null;

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label="Open audit log"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-white/70 hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        >
          <ScrollText className="h-4 w-4" />
        </button>
      </DrawerTrigger>
      <DrawerContent className="max-w-lg">
        <AuditLogInspector />
      </DrawerContent>
    </Drawer>
  );
}

function AuditLogInspector() {
  const [actionFilter, setActionFilter] = useState<string>('ALL');
  const [actorSearch, setActorSearch] = useState('');

  const actions = useAuditActions();
  const events = useAuditEvents({
    action: actionFilter === 'ALL' ? undefined : actionFilter,
    take: 100,
  });

  const filtered = useMemo(() => {
    const list = events.data ?? [];
    if (!actorSearch.trim()) return list;
    const needle = actorSearch.trim().toLowerCase();
    return list.filter(
      (e) =>
        e.actorName?.toLowerCase().includes(needle) ||
        e.actorEmail?.toLowerCase().includes(needle),
    );
  }, [events.data, actorSearch]);

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <ScrollText className="h-5 w-5 mt-0.5 text-sky-300" />
          <div className="flex-1 min-w-0">
            <DrawerTitle>Audit log</DrawerTitle>
            <DrawerDescription>
              Last 100 privileged actions. Append-only — entries can't be
              edited or deleted.
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* Filters */}
        <div className="grid grid-cols-2 gap-2">
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
            <Label>Actor</Label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white/45" />
              <Input
                value={actorSearch}
                onChange={(e) => setActorSearch(e.target.value)}
                placeholder="Name or email"
                className="pl-7"
              />
            </div>
          </div>
        </div>

        {/* List */}
        {events.isLoading ? (
          <div className="space-y-2">
            <SkeletonLine />
            <SkeletonLine />
            <SkeletonLine />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-white/55">
            No events match the current filters.
          </p>
        ) : (
          <div className="rounded-md border border-white/10 bg-white/[0.03] divide-y divide-white/5">
            {filtered.map((e) => (
              <AuditEventRowView key={e.id} event={e} />
            ))}
          </div>
        )}
      </DrawerBody>
    </>
  );
}

function AuditEventRowView({ event }: { event: AuditEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload =
    event.payload !== null &&
    event.payload !== undefined &&
    !(typeof event.payload === 'object' && Object.keys(event.payload as object).length === 0);

  return (
    <div className="px-3 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar name={event.actorName ?? event.actorEmail ?? '—'} size="sm" />
          <div className="min-w-0">
            <div className="font-medium truncate">
              {event.actorName ?? event.actorEmail ?? '—'}
            </div>
            <div className="text-[10px] text-white/45 truncate">
              {event.actorEmail ?? '—'}
            </div>
          </div>
        </div>
        <Badge variant="muted" className="font-mono text-[10px] shrink-0">
          {event.action}
        </Badge>
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-white/45">
        <span>{formatDateTime(event.createdAt)}</span>
        {event.targetType && (
          <span className="font-mono truncate">
            {event.targetType}
            {event.targetId ? `:${event.targetId.slice(0, 8)}…` : ''}
          </span>
        )}
      </div>

      {hasPayload && (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="mt-1.5 text-[10px] text-sky-300 hover:text-sky-200"
        >
          {expanded ? 'Hide payload' : 'Show payload'}
        </button>
      )}
      {expanded && hasPayload && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-black/40 p-2 text-[10px] text-white/65">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
