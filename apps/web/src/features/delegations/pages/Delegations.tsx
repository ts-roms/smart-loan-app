import {
  useCreateDelegation,
  useDelegationUserDirectory,
  useMyDelegations,
  usePermissions,
  useRevokeDelegation,
  type DelegationUserEntry,
} from '@loan/api-client';
import type { Delegation, Permission } from '@loan/shared-types';
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
  usePrompt,
  useToast,
} from '@loan/ui';
import { formatDate, formatDateTime } from '@loan/shared-utils';
import { CalendarClock, Plus, ShieldCheck, Undo2, Users } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useAuth } from '../../../providers/auth';

/**
 * Role delegation — granting a time-bounded subset of your permissions to
 * another user. The page is split into two lists:
 *   - "Granted by me" (outbound): I delegated my authority to others
 *   - "Granted to me" (inbound, held): others delegated to me
 *
 * Admins (admin.users) can additionally use this page to create a delegation
 * on behalf of someone else, but the default form pre-selects the caller as
 * delegator.
 */
export function DelegationsPage() {
  const mine = useMyDelegations();
  const users = useDelegationUserDirectory();
  const perms = usePermissions();
  const revoke = useRevokeDelegation();
  const toast = useToast();
  const prompt = usePrompt();
  const { user: me } = useAuth();
  const [creating, setCreating] = useState(false);

  const userById = useMemo(() => {
    const map = new Map<string, DelegationUserEntry>();
    for (const u of users.data ?? []) map.set(u.id, u);
    return map;
  }, [users.data]);

  const onRevoke = async (d: Delegation) => {
    const reason = await prompt({
      title: 'Revoke delegation?',
      message:
        'The delegate loses these permissions immediately. Optional: add a reason for the audit log.',
      label: 'Reason (optional)',
      placeholder: 'e.g. role mistake, returned from leave early',
      confirmLabel: 'Revoke',
    });
    if (reason === null) return; // user cancelled
    try {
      await revoke.mutateAsync({ id: d.id, reason: reason || undefined });
      toast.success('Delegation revoked');
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed to revoke');
    }
  };

  const granted = mine.data?.granted ?? [];
  const held = mine.data?.held ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-sky-300" />
            Delegations
          </CardTitle>
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New delegation
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/55 mb-3">
            Time-bounded proxy authority. The delegate uses their own login,
            but during the window they inherit the listed permissions from
            you. Empty permission list = blanket — they inherit everything
            you currently hold.
          </p>
        </CardContent>
      </Card>

      <DelegationList
        title="Granted to me"
        subtitle="Delegations where I'm the proxy. While active, I gain the listed permissions from the delegator."
        rows={held}
        direction="held"
        userById={userById}
        loading={mine.isLoading}
        meId={me?.id}
        onRevoke={onRevoke}
      />

      <DelegationList
        title="Granted by me"
        subtitle="Delegations I've issued to other users. I can revoke any of them at any time."
        rows={granted}
        direction="granted"
        userById={userById}
        loading={mine.isLoading}
        meId={me?.id}
        onRevoke={onRevoke}
      />

      {creating && (
        <CreateDialog
          users={users.data ?? []}
          permissions={perms.data ?? []}
          meId={me?.id}
          onClose={() => setCreating(false)}
        />
      )}
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
}: {
  title: string;
  subtitle: string;
  rows: Delegation[];
  direction: 'granted' | 'held';
  userById: Map<string, DelegationUserEntry>;
  loading: boolean;
  meId?: string;
  onRevoke: (d: Delegation) => void;
}) {
  const now = new Date();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-white/55 mb-3">{subtitle}</p>
        {loading ? (
          <SkeletonCard />
        ) : rows.length === 0 ? (
          <p className="text-sm text-white/55">No delegations.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">
                  {direction === 'granted' ? 'Delegate' : 'Delegator'}
                </th>
                <th className="py-2 px-2">Permissions</th>
                <th className="py-2 px-2">Window</th>
                <th className="py-2 px-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((d) => {
                const otherId = direction === 'granted' ? d.delegateId : d.delegatorId;
                const other = userById.get(otherId);
                const starts = new Date(d.startsAt);
                const ends = new Date(d.endsAt);
                const status = d.revokedAt
                  ? 'revoked'
                  : now < starts
                    ? 'scheduled'
                    : now > ends
                      ? 'expired'
                      : 'active';
                const canRevoke =
                  !d.revokedAt && status !== 'expired' && d.delegatorId === meId;
                return (
                  <tr key={d.id} className="hover:bg-white/[0.03] align-top">
                    <td className="py-2 px-2">
                      <div>{other?.name ?? otherId.slice(0, 8)}</div>
                      <div className="text-xs text-white/45">{other?.email ?? '—'}</div>
                    </td>
                    <td className="py-2 px-2">
                      {d.permissions.length === 0 ? (
                        <Badge variant="muted">Blanket (all)</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1 max-w-md">
                          {d.permissions.slice(0, 6).map((p) => (
                            <span
                              key={p}
                              className="font-mono text-[10px] rounded bg-white/[0.06] px-1.5 py-0.5"
                            >
                              {p}
                            </span>
                          ))}
                          {d.permissions.length > 6 && (
                            <span className="text-[10px] text-white/55">
                              +{d.permissions.length - 6} more
                            </span>
                          )}
                        </div>
                      )}
                      {d.note && (
                        <div className="text-xs text-white/55 mt-1">{d.note}</div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-xs">
                      <div>{formatDate(d.startsAt)}</div>
                      <div className="text-white/55">→ {formatDate(d.endsAt)}</div>
                    </td>
                    <td className="py-2 px-2">
                      <Badge
                        variant={
                          status === 'active'
                            ? 'success'
                            : status === 'scheduled'
                              ? 'muted'
                              : 'muted'
                        }
                      >
                        {status}
                      </Badge>
                      {d.revokedAt && (
                        <div className="text-[10px] text-white/45 mt-0.5">
                          {formatDateTime(d.revokedAt)}
                          {d.revokedReason ? ` — ${d.revokedReason}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right">
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

function CreateDialog({
  users,
  permissions,
  meId,
  onClose,
}: {
  users: DelegationUserEntry[];
  permissions: Permission[];
  meId?: string;
  onClose: () => void;
}) {
  const create = useCreateDelegation();
  const toast = useToast();
  const [delegateId, setDelegateId] = useState('');
  const [startsAt, setStartsAt] = useState(() => isoDate(new Date()));
  const [endsAt, setEndsAt] = useState(() =>
    isoDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  );
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const m = new Map<string, Permission[]>();
    for (const p of permissions) {
      const arr = m.get(p.category) ?? [];
      arr.push(p);
      m.set(p.category, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [permissions]);

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };

  const onSubmit = async () => {
    if (!delegateId) {
      toast.error('Pick a delegate');
      return;
    }
    if (delegateId === meId) {
      toast.error('Cannot delegate to yourself');
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      toast.error('End date must be after start date');
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
      toast.success('Delegation created');
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed to create');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-sky-300" />
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

          <div>
            <Label className="flex items-center justify-between">
              <span>Permissions to delegate</span>
              <span className="text-xs text-white/55">
                {picked.size === 0
                  ? 'Empty = blanket (all of my permissions)'
                  : `${picked.size} selected`}
              </span>
            </Label>
            <div className="max-h-72 overflow-y-auto rounded-md border border-white/10 bg-white/[0.02] p-3 space-y-3">
              {grouped.map(([cat, items]) => (
                <div key={cat}>
                  <div className="text-xs uppercase tracking-wider text-white/55 mb-1">
                    {cat}
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {items.map((p) => (
                      <label
                        key={p.key}
                        className="flex items-center gap-2 text-xs cursor-pointer hover:bg-white/[0.03] rounded px-1.5 py-1"
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
              ))}
              {grouped.length === 0 && (
                <p className="text-sm text-white/55">No permissions available.</p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create delegation'}
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
