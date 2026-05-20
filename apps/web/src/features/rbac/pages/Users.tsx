import {
  useAssignRole,
  useRoles,
  useUnassignRole,
  useUsers,
} from '@loan/api-client';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  SkeletonCard,
  useConfirm,
  useToast,
} from '@loan/ui';
import { formatDate } from '@loan/shared-utils';
import { Plus, UserCog, X } from 'lucide-react';
import { useState } from 'react';

import { useAuth } from '../../../providers/auth';

/**
 * Users + role assignments. Each row shows the user's primary role
 * (legacy `User.role` enum) plus any additional roles assigned via the
 * RBAC system.
 */
export function UsersPage() {
  const users = useUsers();
  const roles = useRoles();
  const assign = useAssignRole();
  const unassign = useUnassignRole();
  const toast = useToast();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const canManage = me?.role === 'ADMIN';
  const [assigning, setAssigning] = useState<string | null>(null);

  const onAssign = async (userId: string, roleKey: string) => {
    try {
      await assign.mutateAsync({ userId, roleKey });
      toast.success('Role assigned');
      setAssigning(null);
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
    }
  };

  const onUnassign = async (userId: string, roleKey: string, system: boolean) => {
    const ok = await confirm({
      title: system ? `Remove system role ${roleKey}?` : `Remove role ${roleKey}?`,
      message: system
        ? `They'll lose all permissions granted by ${roleKey}. This is reversible — you can re-assign the role at any time.`
        : `They'll lose all permissions granted by ${roleKey}.`,
      confirmLabel: 'Remove role',
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await unassign.mutateAsync({ userId, roleKey });
      toast.success('Role removed');
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCog className="h-4 w-4" />
          Users
        </CardTitle>
      </CardHeader>
      <CardContent>
        {users.isLoading ? (
          <SkeletonCard />
        ) : (users.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">No users.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Name / Email</th>
                <th className="py-2 px-2">Primary role</th>
                <th className="py-2 px-2">Assigned roles</th>
                <th className="py-2 px-2">Status</th>
                <th className="py-2 px-2">Created</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className="hover:bg-white/[0.03] align-top">
                  <td className="py-2 px-2">
                    <div>{u.name}</div>
                    <div className="text-xs text-white/45">{u.email}</div>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant="muted">{u.primaryRole}</Badge>
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 ? (
                        <span className="text-xs text-white/45">none</span>
                      ) : (
                        u.roles.map((r) => {
                          // Self-lockout: don't show the X on your own ADMIN
                          // role — the API rejects it anyway, this just makes
                          // the UI honest about it.
                          const isSelfAdmin =
                            r.key === 'ADMIN' && u.id === me?.id;
                          return (
                            <span
                              key={r.key}
                              className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-xs"
                            >
                              <span className={r.system ? 'text-sky-300' : 'text-emerald-300'}>{r.name}</span>
                              {canManage && !isSelfAdmin && (
                                <button
                                  type="button"
                                  onClick={() => onUnassign(u.id, r.key, r.system)}
                                  className="text-white/45 hover:text-rose-300"
                                  title={
                                    r.system
                                      ? `Remove system role ${r.name}`
                                      : `Remove role ${r.name}`
                                  }
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </span>
                          );
                        })
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant={u.active ? 'success' : 'muted'}>
                      {u.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-xs text-white/55">{formatDate(u.createdAt)}</td>
                  <td className="py-2 px-2 text-right">
                    {canManage && (
                      <Button size="sm" variant="outline" onClick={() => setAssigning(u.id)}>
                        <Plus className="h-3 w-3" />
                        Assign
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {assigning && (
        <Dialog open onOpenChange={(o) => !o && setAssigning(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Assign a role</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {(roles.data ?? []).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onAssign(assigning, r.key)}
                  className="w-full text-left rounded-md border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span>{r.name}</span>
                    <Badge variant={r.system ? 'muted' : 'success'}>
                      {r.system ? 'System' : 'Custom'}
                    </Badge>
                  </div>
                  {r.description && (
                    <div className="text-xs text-white/45 mt-0.5">{r.description}</div>
                  )}
                  <div className="text-xs text-white/35 mt-0.5">
                    {r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'}
                  </div>
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
