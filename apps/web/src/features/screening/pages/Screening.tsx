import {
  useAddWatchlistEntry,
  useDeleteWatchlistEntry,
  useWatchlist,
} from '@loan/api-client';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from '@loan/ui';
import { ShieldAlert, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useAuth } from '../../../providers/auth';

/**
 * AML watchlist admin. Each entry is consulted by the screening provider
 * whenever a customer is screened. In a real deployment, this table is
 * replaced by a vendor API; the in-app watchlist is useful for internal
 * blocks and for testing.
 */
export function ScreeningPage() {
  const list = useWatchlist();
  const add = useAddWatchlistEntry();
  const remove = useDeleteWatchlistEntry();
  const toast = useToast();
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN';
  const [draft, setDraft] = useState({
    list: 'INTERNAL',
    fullName: '',
    aliases: '',
    reason: '',
  });

  const onAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.fullName.trim()) return;
    try {
      await add.mutateAsync({
        list: draft.list,
        fullName: draft.fullName,
        aliases: draft.aliases
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        reason: draft.reason || undefined,
      });
      toast.success('Added');
      setDraft({ list: 'INTERNAL', fullName: '', aliases: '', reason: '' });
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-300" />
          AML watchlist
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-white/55">
          Entries here cause exact-name (or partial-name) matches when customers
          are screened. Real deployments replace this with a vendor API; the
          internal list is still useful for hard-blocks (e.g. known fraudsters,
          customers in litigation).
        </p>

        {canEdit && (
          <form onSubmit={onAdd} className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <Select value={draft.list} onValueChange={(v) => setDraft({ ...draft, list: v })}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="INTERNAL">INTERNAL</SelectItem>
                <SelectItem value="PEP">PEP</SelectItem>
                <SelectItem value="SANCTIONS">SANCTIONS</SelectItem>
                <SelectItem value="ADVERSE_MEDIA">ADVERSE_MEDIA</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Full name"
              value={draft.fullName}
              onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
              required
            />
            <Input
              placeholder="Aliases (comma-separated)"
              value={draft.aliases}
              onChange={(e) => setDraft({ ...draft, aliases: e.target.value })}
              className="md:col-span-2"
            />
            <Input
              placeholder="Reason"
              value={draft.reason}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            />
            <Button type="submit" disabled={add.isPending || !draft.fullName.trim()} className="md:col-span-5">
              {add.isPending ? 'Adding…' : 'Add entry'}
            </Button>
          </form>
        )}

        {list.isLoading ? (
          <SkeletonCard />
        ) : (list.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">No entries yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">List</th>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Aliases</th>
                <th className="py-2 px-2">Reason</th>
                <th className="py-2 px-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(list.data ?? []).map((w) => (
                <tr key={w.id} className="hover:bg-white/[0.03]">
                  <td className="py-2 px-2">
                    <Badge variant={w.list === 'SANCTIONS' ? 'danger' : 'warning'}>{w.list}</Badge>
                  </td>
                  <td className="py-2 px-2">{w.fullName}</td>
                  <td className="py-2 px-2 text-white/65 text-xs">{w.aliases.join(', ')}</td>
                  <td className="py-2 px-2 text-white/65 text-xs">{w.reason ?? '—'}</td>
                  <td className="py-2 px-2 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => remove.mutate(w.id)}
                        className="text-white/55 hover:text-rose-300"
                        title="Remove"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
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
