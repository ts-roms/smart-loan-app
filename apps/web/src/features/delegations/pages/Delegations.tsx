import {
  useCreateDelegation,
  useDelegationPreview,
  useDelegationUserDirectory,
  useExtendDelegation,
  useMyDelegations,
  usePermissions,
  useRevokeDelegation,
  useRoles,
  type DelegationUserEntry,
} from "@loan/api-client";
import type {
  Delegation,
  Permission,
  RoleWithPermissions,
} from "@loan/shared-types";
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
  DatePicker,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  cn,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDate, formatDateTime } from "@loan/shared-utils";
import {
  AlertTriangle,
  CalendarClock,
  CalendarPlus,
  Eye,
  Plus,
  Search,
  ShieldCheck,
  Undo2,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useAuth } from "../../../providers/auth";
import { findArticle, TourButton } from "../../help";

// ─── Status helpers ────────────────────────────────────────────────

type Status = "active" | "scheduled" | "expiring-soon" | "expired" | "revoked";

/**
 * "Expiring soon" = active AND ends within the next 48 hours. Tuned
 * to the typical lead time officers need to either extend or hand
 * back the work; 24h was too short, 7d caught too many false alarms.
 */
const EXPIRING_SOON_WINDOW_MS = 48 * 60 * 60 * 1000;

function computeStatus(d: Delegation, now = new Date()): Status {
  if (d.revokedAt) return "revoked";
  const starts = new Date(d.startsAt);
  const ends = new Date(d.endsAt);
  if (now < starts) return "scheduled";
  if (now > ends) return "expired";
  if (ends.getTime() - now.getTime() <= EXPIRING_SOON_WINDOW_MS)
    return "expiring-soon";
  return "active";
}

const STATUS_LABEL: Record<Status, string> = {
  active: "Active",
  scheduled: "Scheduled",
  "expiring-soon": "Expiring soon",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_VARIANT: Record<
  Status,
  "success" | "muted" | "warning" | "danger"
> = {
  active: "success",
  scheduled: "muted",
  "expiring-soon": "warning",
  expired: "muted",
  revoked: "danger",
};

/**
 * Role delegation page. Two lists (granted vs held), inline filters,
 * summary counts, expiring-soon banner, and per-row extend/revoke.
 * The create dialog supports role templates ("delegate as ACCOUNTANT")
 * and per-category bulk select for ad-hoc combinations.
 */
export function DelegationsPage() {
  const mine = useMyDelegations();
  const users = useDelegationUserDirectory();
  const perms = usePermissions();
  const rolesQuery = useRoles();
  const revoke = useRevokeDelegation();
  const extend = useExtendDelegation();
  const toast = useToast();
  const prompt = usePrompt();
  const { user: me } = useAuth();
  const [creating, setCreating] = useState(false);
  // Preview-dialog state. Single string holds the id of the
  // delegation currently being inspected — null means closed.
  const [previewId, setPreviewId] = useState<string | null>(null);

  // ── Filter state ───────────────────────────────────────────────
  const [statusFilter, setStatusFilter] = useState<"all" | Status>("all");
  const [query, setQuery] = useState("");

  const userById = useMemo(() => {
    const map = new Map<string, DelegationUserEntry>();
    for (const u of users.data ?? []) map.set(u.id, u);
    return map;
  }, [users.data]);

  // ── Derived: status + name lookup applied to both lists. ───────
  // Memoized rather than `?? []` inline: the fallback array would be a new
  // identity every render, changing `all`'s deps each pass.
  const granted = useMemo(() => mine.data?.granted ?? [], [mine.data]);
  const held = useMemo(() => mine.data?.held ?? [], [mine.data]);
  const all = useMemo(() => [...granted, ...held], [granted, held]);

  const summary = useMemo(() => {
    const counts: Record<Status, number> = {
      active: 0,
      scheduled: 0,
      "expiring-soon": 0,
      expired: 0,
      revoked: 0,
    };
    for (const d of all) counts[computeStatus(d)]++;
    return counts;
  }, [all]);

  // Filter predicate shared between both lists.
  const matches = (d: Delegation, direction: "granted" | "held"): boolean => {
    if (statusFilter !== "all" && computeStatus(d) !== statusFilter)
      return false;
    if (query.trim()) {
      const otherId = direction === "granted" ? d.delegateId : d.delegatorId;
      const other = userById.get(otherId);
      const haystack =
        `${other?.name ?? ""} ${other?.email ?? ""} ${d.note ?? ""}`.toLowerCase();
      if (!haystack.includes(query.trim().toLowerCase())) return false;
    }
    return true;
  };
  const filteredGranted = granted.filter((d) => matches(d, "granted"));
  const filteredHeld = held.filter((d) => matches(d, "held"));

  // Expiring soon — only delegations I own. The delegate doesn't
  // control these, so showing it to them as a banner adds noise.
  const expiringSoon = granted.filter(
    (d) => computeStatus(d) === "expiring-soon",
  );

  const onRevoke = async (d: Delegation) => {
    const reason = await prompt({
      title: "Revoke delegation?",
      message:
        "The delegate loses these permissions immediately. Optional: add a reason for the audit log.",
      label: "Reason (optional)",
      placeholder: "e.g. role mistake, returned from leave early",
      confirmLabel: "Revoke",
    });
    if (reason === null) return;
    try {
      await revoke.mutateAsync({ id: d.id, reason: reason || undefined });
      toast.success("Delegation revoked");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to revoke");
    }
  };

  const onExtend = async (d: Delegation, days: number) => {
    // Push end date by `days` from its current value (not from now).
    // Cumulative extensions stack as expected: a "+ 7d" after the
    // original end date gives you 7 more calendar days, not "7 days
    // from when you clicked".
    const newEnd = new Date(d.endsAt);
    newEnd.setDate(newEnd.getDate() + days);
    try {
      await extend.mutateAsync({ id: d.id, endsAt: newEnd.toISOString() });
      toast.success(`Extended by ${days} day${days === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to extend");
    }
  };

  return (
    <div className="space-y-4" data-tour="delegations-root">
      {/* Header with tour + new delegation button */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-info" />
            Delegations
          </CardTitle>
          <div className="flex items-center gap-2">
            <TourButton
              tourId="delegations"
              steps={findArticle("delegations")?.tour ?? []}
            />
            <Button
              onClick={() => setCreating(true)}
              data-tour="delegations-new"
            >
              <Plus className="h-4 w-4" />
              New delegation
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-fg-muted mb-3">
            Time-bounded proxy authority. The delegate uses their own login, but
            during the window they inherit the listed permissions from you.
            Empty permission list = blanket — they inherit everything you
            currently hold.
          </p>

          {/* Status filter chips with counts */}
          <div
            className="flex items-center flex-wrap gap-2 mb-3"
            data-tour="delegations-filters"
          >
            <StatusChip
              label={`All · ${all.length}`}
              active={statusFilter === "all"}
              onClick={() => setStatusFilter("all")}
            />
            <StatusChip
              label={`Active · ${summary.active}`}
              tone="success"
              active={statusFilter === "active"}
              onClick={() => setStatusFilter("active")}
            />
            <StatusChip
              label={`Scheduled · ${summary.scheduled}`}
              tone="muted"
              active={statusFilter === "scheduled"}
              onClick={() => setStatusFilter("scheduled")}
            />
            <StatusChip
              label={`Expiring soon · ${summary["expiring-soon"]}`}
              tone="warning"
              active={statusFilter === "expiring-soon"}
              onClick={() => setStatusFilter("expiring-soon")}
            />
            <StatusChip
              label={`Expired · ${summary.expired}`}
              tone="muted"
              active={statusFilter === "expired"}
              onClick={() => setStatusFilter("expired")}
            />
            <StatusChip
              label={`Revoked · ${summary.revoked}`}
              tone="danger"
              active={statusFilter === "revoked"}
              onClick={() => setStatusFilter("revoked")}
            />
            {/* Search shares the toolbar — collapses to the right on wide screens */}
            <div className="ml-auto relative">
              <Search className="h-3 w-3 text-fg-subtle absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, email, or note"
                className="pl-7 h-8 text-xs w-56"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Expiring-soon banner — only when there's something to act on */}
      {expiringSoon.length > 0 && (
        <ExpiringSoonBanner
          rows={expiringSoon}
          userById={userById}
          onExtend={onExtend}
        />
      )}

      <DelegationList
        title="Granted to me"
        subtitle="Delegations where I'm the proxy. While active, I gain the listed permissions from the delegator."
        rows={filteredHeld}
        direction="held"
        userById={userById}
        loading={mine.isLoading}
        meId={me?.id}
        onRevoke={onRevoke}
        onExtend={onExtend}
        onPreview={(d) => setPreviewId(d.id)}
      />

      <DelegationList
        title="Granted by me"
        subtitle="Delegations I've issued to other users. I can revoke or extend any of them at any time."
        rows={filteredGranted}
        direction="granted"
        userById={userById}
        loading={mine.isLoading}
        meId={me?.id}
        onRevoke={onRevoke}
        onExtend={onExtend}
        onPreview={(d) => setPreviewId(d.id)}
      />

      {creating && (
        <CreateDialog
          users={users.data ?? []}
          permissions={perms.data ?? []}
          roles={rolesQuery.data ?? []}
          meId={me?.id}
          onClose={() => setCreating(false)}
        />
      )}

      {previewId && (
        <DelegationPreviewDialog
          id={previewId}
          userById={userById}
          onClose={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}

/**
 * Resolved-permissions preview dialog. Shows what permissions the
 * delegation actually grants the delegate right now — the
 * `resolvedPermissions` set — and, importantly, any keys the
 * delegation explicitly listed that the delegator no longer holds
 * (`droppedPermissions`). A non-empty dropped list is the signal
 * "something changed on the delegator's side; this delegation isn't
 * delivering what it originally promised".
 */
function DelegationPreviewDialog({
  id,
  userById,
  onClose,
}: {
  id: string;
  userById: Map<string, DelegationUserEntry>;
  onClose: () => void;
}) {
  const query = useDelegationPreview(id);
  const data = query.data;
  const delegator = data ? userById.get(data.delegation.delegatorId) : null;
  const delegate = data ? userById.get(data.delegation.delegateId) : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-info" />
            Resolved permissions
          </DialogTitle>
        </DialogHeader>

        {query.isLoading ? (
          <SkeletonCard />
        ) : query.isError ? (
          <div className="text-sm text-danger bg-danger/5 border border-danger/20 rounded px-3 py-2">
            {query.error.message}
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className="text-xs text-fg-muted">
              <span className="text-fg">
                {delegate?.name ?? data.delegation.delegateId.slice(0, 8)}
              </span>{" "}
              gains permissions delegated by{" "}
              <span className="text-fg">
                {delegator?.name ?? data.delegation.delegatorId.slice(0, 8)}
              </span>
              .{" "}
              {data.isActiveNow ? (
                <Badge variant="success">Active now</Badge>
              ) : (
                <Badge variant="muted">Not active</Badge>
              )}
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5">
                {data.delegation.permissions.length === 0
                  ? `Resolved (all of delegator's permissions)`
                  : "Resolved permissions"}
              </div>
              {data.resolvedPermissions.length === 0 ? (
                <p className="text-xs text-fg-muted">
                  No permissions are currently granted by this delegation.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {data.resolvedPermissions.map((p) => (
                    <span
                      key={p}
                      className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-info/10 text-info"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {data.droppedPermissions.length > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning/[0.04] p-3">
                <div className="flex items-center gap-2 text-warning text-xs font-medium">
                  <AlertTriangle className="h-3 w-3" />
                  Dropped from the original delegation
                </div>
                <p className="text-xs text-fg-muted mt-1">
                  The delegator no longer holds these keys, so they're silently
                  excluded from what the delegate actually receives right now.
                </p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {data.droppedPermissions.map((p) => (
                    <span
                      key={p}
                      className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-warning/10 text-warning line-through"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
              Window
            </div>
            <div className="text-xs text-fg">
              {formatDateTime(data.delegation.startsAt)} →{" "}
              {formatDateTime(data.delegation.endsAt)}
              {data.delegation.revokedAt && (
                <span className="ml-2 text-danger">
                  · revoked {formatDateTime(data.delegation.revokedAt)}
                </span>
              )}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Reusable bits ─────────────────────────────────────────────────

function StatusChip({
  label,
  tone,
  active,
  onClick,
}: {
  label: string;
  tone?: "success" | "muted" | "warning" | "danger";
  active: boolean;
  onClick: () => void;
}) {
  const toneRing = {
    success: "ring-success/30 hover:ring-success/60",
    warning: "ring-warning/30 hover:ring-warning/60",
    danger: "ring-danger/30 hover:ring-danger/60",
    muted: "ring-border-strong hover:ring-border-strong",
  }[tone ?? "muted"];
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-xs font-medium border transition-colors",
        active
          ? "border-info/60 bg-info/15 text-info"
          : `border-transparent ring-1 ${toneRing} text-fg hover:text-fg`,
      )}
    >
      {label}
    </button>
  );
}

function ExpiringSoonBanner({
  rows,
  userById,
  onExtend,
}: {
  rows: Delegation[];
  userById: Map<string, DelegationUserEntry>;
  onExtend: (d: Delegation, days: number) => void;
}) {
  return (
    <div className="rounded-md border border-warning/30 bg-warning/10 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-warning">
        <AlertTriangle className="h-4 w-4 text-warning" />
        {rows.length} delegation{rows.length === 1 ? "" : "s"} expiring in the
        next 48 hours
      </div>
      <ul className="space-y-1.5">
        {rows.map((d) => {
          const other = userById.get(d.delegateId);
          return (
            <li
              key={d.id}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="truncate">
                <span className="text-fg">
                  {other?.name ?? d.delegateId.slice(0, 8)}
                </span>
                <span className="text-fg-muted">
                  {" "}
                  · ends {formatDateTime(d.endsAt)}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onExtend(d, 7)}
                title="Extend the end date by 7 days"
              >
                <CalendarPlus className="h-3 w-3" />
                Extend +7d
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DelegationList({
  title,
  subtitle,
  rows,
  direction,
  userById,
  loading,
  meId,
  onRevoke,
  onExtend,
  onPreview,
}: {
  title: string;
  subtitle: string;
  rows: Delegation[];
  direction: "granted" | "held";
  userById: Map<string, DelegationUserEntry>;
  loading: boolean;
  meId?: string;
  onRevoke: (d: Delegation) => void;
  onExtend: (d: Delegation, days: number) => void;
  onPreview: (d: Delegation) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-fg-muted mb-3">{subtitle}</p>
        {loading ? (
          <SkeletonCard />
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No delegations match the current filter.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">
                  {direction === "granted" ? "Delegate" : "Delegator"}
                </th>
                <th className="py-2 px-2">Permissions</th>
                <th className="py-2 px-2">Window</th>
                <th className="py-2 px-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {rows.map((d) => {
                const otherId =
                  direction === "granted" ? d.delegateId : d.delegatorId;
                const other = userById.get(otherId);
                const status = computeStatus(d);
                const isMine = d.delegatorId === meId;
                const canRevoke =
                  !d.revokedAt && status !== "expired" && isMine;
                const canExtend =
                  isMine && (status === "active" || status === "expiring-soon");
                return (
                  <tr key={d.id} className="hover:bg-hover align-top">
                    <td className="py-2 px-2">
                      <div>{other?.name ?? otherId.slice(0, 8)}</div>
                      <div className="text-xs text-fg-subtle">
                        {other?.email ?? "—"}
                      </div>
                    </td>
                    <td className="py-2 px-2">
                      {d.permissions.length === 0 ? (
                        <Badge variant="muted">Blanket (all)</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-md">
                          {d.permissions.slice(0, 6).map((p) => (
                            <span
                              key={p}
                              className="font-mono text-[10px] rounded bg-surface-3 px-1.5 py-0.5"
                            >
                              {p}
                            </span>
                          ))}
                          {d.permissions.length > 6 && (
                            <span className="text-[10px] text-fg-muted">
                              +{d.permissions.length - 6} more
                            </span>
                          )}
                        </div>
                      )}
                      {d.note && (
                        <div className="text-xs text-fg-muted mt-1">
                          {d.note}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      <div>{formatDate(d.startsAt)}</div>
                      <div className="text-fg-muted">
                        → {formatDate(d.endsAt)}
                      </div>
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant={STATUS_VARIANT[status]}>
                        {STATUS_LABEL[status]}
                      </Badge>
                      {d.revokedAt && (
                        <div className="text-[10px] text-fg-subtle mt-0.5">
                          {formatDateTime(d.revokedAt)}
                          {d.revokedReason ? ` — ${d.revokedReason}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onPreview(d)}
                          title="Preview resolved permissions"
                        >
                          <Eye className="h-3 w-3" />
                          Preview
                        </Button>
                        {canExtend && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onExtend(d, 7)}
                            title="Extend the end date by 7 days"
                          >
                            <CalendarPlus className="h-3 w-3" />
                            +7d
                          </Button>
                        )}
                        {canRevoke && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => onRevoke(d)}
                            title="Revoke this delegation"
                          >
                            <Undo2 className="h-3 w-3" />
                            Revoke
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Create dialog ─────────────────────────────────────────────────

function CreateDialog({
  users,
  permissions,
  roles,
  meId,
  onClose,
}: {
  users: DelegationUserEntry[];
  permissions: Permission[];
  roles: RoleWithPermissions[];
  meId?: string;
  onClose: () => void;
}) {
  const create = useCreateDelegation();
  const toast = useToast();
  const [delegateId, setDelegateId] = useState("");
  const [startsAt, setStartsAt] = useState(() => isoDate(new Date()));
  const [endsAt, setEndsAt] = useState(() =>
    isoDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  );
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Group permissions by category for the picker.
  const grouped = useMemo(() => {
    const m = new Map<string, Permission[]>();
    for (const p of permissions) {
      const arr = m.get(p.category) ?? [];
      arr.push(p);
      m.set(p.category, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [permissions]);

  // Role templates — surface only roles the catalog actually has;
  // skips empty roles (no permissions assigned). Sort by user-impact
  // first: ADMIN, then alphabetical for the rest.
  const roleTemplates = useMemo(() => {
    return roles
      .filter((r) => r.permissions.length > 0)
      .sort((a, b) => {
        if (a.key === "ADMIN") return -1;
        if (b.key === "ADMIN") return 1;
        return a.name.localeCompare(b.name);
      });
  }, [roles]);

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };

  const applyTemplate = (role: RoleWithPermissions) => {
    // Replace (not union) — clicking a different template wipes the
    // previous one. Removes the surprise where two templates compound
    // into a permission set the officer didn't intend.
    setPicked(new Set(role.permissions.map((rp) => rp.permission.key)));
    toast.success(
      `${role.permissions.length} permissions pre-selected from ${role.name}`,
    );
  };

  const toggleCategory = (
    category: string,
    items: Permission[],
    action: "all" | "clear",
  ) => {
    const next = new Set(picked);
    for (const p of items) {
      if (action === "all") next.add(p.key);
      else next.delete(p.key);
    }
    setPicked(next);
  };

  const onSubmit = async () => {
    if (!delegateId) {
      toast.error("Pick a delegate");
      return;
    }
    if (delegateId === meId) {
      toast.error("Cannot delegate to yourself");
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      toast.error("End date must be after start date");
      return;
    }
    try {
      await create.mutateAsync({
        delegateId,
        permissions: Array.from(picked),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        note: note || undefined,
      });
      toast.success("Delegation created");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to create");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-info" />
            New delegation
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Delegate to</Label>
            <Select value={delegateId} onValueChange={setDelegateId}>
              <SelectTrigger>
                <SelectValue placeholder="— pick a user —" />
              </SelectTrigger>
              <SelectContent>
                {users
                  .filter((u) => u.id !== meId)
                  .map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name} ({u.email}) — {u.role}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Starts</Label>
              <DatePicker value={startsAt} onChange={setStartsAt} />
            </div>
            <div>
              <Label>Ends</Label>
              <DatePicker value={endsAt} onChange={setEndsAt} min={startsAt} />
            </div>
          </div>

          <div>
            <Label>Note (optional)</Label>
            <Input
              placeholder="e.g. covering for branch manager during Q2 leave"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {/* Role templates — one-click permission set for common scenarios */}
          {roleTemplates.length > 0 && (
            <div>
              <Label className="flex items-center justify-between">
                <span>Quick-pick by role</span>
                {picked.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setPicked(new Set())}
                    className="text-xs text-info hover:underline"
                  >
                    Clear all
                  </button>
                )}
              </Label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {roleTemplates.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => applyTemplate(r)}
                    className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/10 hover:bg-info/20 px-2.5 py-1 text-xs"
                  >
                    <ShieldCheck className="h-3 w-3 text-info" />
                    Delegate as {r.name}
                    <span className="text-fg-subtle text-[10px]">
                      ({r.permissions.length})
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-fg-subtle mt-1">
                Pre-fills the permission list below with that role's
                permissions. Edit afterward to fine-tune.
              </p>
            </div>
          )}

          <div>
            <Label className="flex items-center justify-between">
              <span>Permissions to delegate</span>
              <span className="text-xs text-fg-muted">
                {picked.size === 0
                  ? "Empty = blanket (all of my permissions)"
                  : `${picked.size} selected`}
              </span>
            </Label>
            <div className="max-h-72 overflow-y-auto rounded-md border border-default bg-surface-2 p-3 space-y-3">
              {grouped.map(([cat, items]) => {
                const pickedInCat = items.filter((p) =>
                  picked.has(p.key),
                ).length;
                const allPicked = pickedInCat === items.length;
                return (
                  <div key={cat}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-xs uppercase tracking-wider text-fg-muted">
                        {cat}
                        {pickedInCat > 0 && (
                          <span className="ml-1 text-[10px] text-info">
                            ({pickedInCat}/{items.length})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px]">
                        <button
                          type="button"
                          onClick={() =>
                            toggleCategory(
                              cat,
                              items,
                              allPicked ? "clear" : "all",
                            )
                          }
                          className="text-info hover:underline"
                        >
                          {allPicked ? "Clear" : "Select all"}
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      {items.map((p) => (
                        <label
                          key={p.key}
                          className="flex items-center gap-2 text-xs cursor-pointer hover:bg-hover rounded px-1.5 py-1"
                        >
                          <input
                            type="checkbox"
                            checked={picked.has(p.key)}
                            onChange={() => toggle(p.key)}
                          />
                          <span className="font-mono">{p.key}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              {grouped.length === 0 && (
                <p className="text-sm text-fg-muted">
                  No permissions available.
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create delegation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The cross-app `ActiveDelegationBanner` lives in its own file under
// features/delegations/components — it's rendered by DashboardShell, not
// from this page.
