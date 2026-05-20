import {
  useCreateRole,
  useDeleteRole,
  usePermissions,
  useRoles,
  useUpdateRole,
} from '@loan/api-client';
import type { Permission, RoleWithPermissions } from '@loan/shared-types';
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
  SkeletonCard,
  useConfirm,
  useToast,
} from '@loan/ui';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { useAuth } from '../../../providers/auth';

/**
 * Roles + permission matrix admin. Each role is a named collection of
 * permission keys; the matrix is grouped by category for legibility.
 * System roles can be edited but not deleted (the `system` flag is enforced
 * by the API).
 */
export function RolesPage() {
  const roles = useRoles();
  const permissions = usePermissions();
  const remove = useDeleteRole();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [editing, setEditing] = useState<RoleWithPermissions | null>(null);
  const [creating, setCreating] = useState(false);

  const onDelete = async (r: RoleWithPermissions) => {
    if (r.system) {
      toast.error('System roles cannot be deleted.');
      return;
    }
    const assignedCount = r._count?.users ?? 0;
    const ok = await confirm({
      title: `Delete role "${r.name}"?`,
      message:
        assignedCount > 0
          ? `This role is currently assigned to ${assignedCount} user${assignedCount === 1 ? '' : 's'}. They'll lose every permission this role grants.`
          : 'This is reversible only by re-creating the role from scratch.',
      confirmLabel: 'Delete role',
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(r.key);
      toast.success('Role deleted');
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-sky-300" />
          Roles & permissions
        </CardTitle>
        {isAdmin && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            New role
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-xs text-white/55 mb-3">
          Each role is a collection of fine-grained permissions. Users can hold
          multiple roles; their effective permissions are the union across all
          of them.
        </p>
        {roles.isLoading ? (
          <SkeletonCard />
        ) : (roles.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">No roles configured.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Key</th>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2 text-right">Permissions</th>
                <th className="py-2 px-2 text-right">Users</th>
                <th className="py-2 px-2">Type</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(roles.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.03]">
                  <td className="py-2 px-2 font-mono text-xs">{r.key}</td>
                  <td className="py-2 px-2">
                    <div>{r.name}</div>
                    {r.description && (
                      <div className="text-xs text-white/45">{r.description}</div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right font-mono">{r.permissions.length}</td>
                  <td className="py-2 px-2 text-right">{r._count?.users ?? 0}</td>
                  <td className="py-2 px-2">
                    <Badge variant={r.system ? 'muted' : 'success'}>
                      {r.system ? 'System' : 'Custom'}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-right">
                    {isAdmin && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(r)}
                          className="text-white/55 hover:text-sky-300"
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        {!r.system && (
                          <button
                            type="button"
                            onClick={() => onDelete(r)}
                            className="text-white/55 hover:text-rose-300"
                            title="Delete"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {creating && permissions.data && (
        <RoleDialog
          allPermissions={permissions.data}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && permissions.data && (
        <RoleDialog
          allPermissions={permissions.data}
          role={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function RoleDialog({
  role,
  allPermissions,
  onClose,
}: {
  role?: RoleWithPermissions;
  allPermissions: Permission[];
  onClose: () => void;
}) {
  const create = useCreateRole();
  const update = useUpdateRole();
  const toast = useToast();
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(role?.permissions.map((rp) => rp.permission.key) ?? []),
  );

  // Group the catalog by category for the matrix UI.
  const grouped = useMemo(() => {
    const byCategory = new Map<string, Permission[]>();
    for (const p of allPermissions) {
      (byCategory.get(p.category) ?? byCategory.set(p.category, []).get(p.category)!).push(p);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [allPermissions]);

  const togglePerm = (perm: string) => {
    const next = new Set(selected);
    if (next.has(perm)) next.delete(perm);
    else next.add(perm);
    setSelected(next);
  };

  const toggleCategory = (perms: Permission[]) => {
    const next = new Set(selected);
    const allSelected = perms.every((p) => next.has(p.key));
    if (allSelected) for (const p of perms) next.delete(p.key);
    else for (const p of perms) next.add(p.key);
    setSelected(next);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (role) {
        await update.mutateAsync({
          key: role.key,
          name,
          description: description || undefined,
          permissions: [...selected],
        });
        toast.success('Role saved');
      } else {
        await create.mutateAsync({
          key,
          name,
          description: description || undefined,
          permissions: [...selected],
        });
        toast.success(`Role ${key} created`);
      }
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{role ? `Edit ${role.name}` : 'New role'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key (UPPER_SNAKE)">
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="BRANCH_MANAGER"
                disabled={!!role}
                required
              />
            </Field>
            <Field label="Display name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
          </div>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>

          <div className="rounded-md border border-white/10">
            <div className="px-3 py-2 text-xs uppercase tracking-wider text-white/45 border-b border-white/10 flex items-center justify-between">
              <span>Permissions ({selected.size})</span>
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    selected.size === allPermissions.length
                      ? new Set()
                      : new Set(allPermissions.map((p) => p.key)),
                  )
                }
                className="text-sky-300 hover:underline normal-case tracking-normal"
              >
                {selected.size === allPermissions.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="divide-y divide-white/5 max-h-80 overflow-y-auto">
              {grouped.map(([category, perms]) => {
                const allOn = perms.every((p) => selected.has(p.key));
                const someOn = perms.some((p) => selected.has(p.key));
                return (
                  <div key={category} className="p-2">
                    <label className="flex items-center gap-2 text-xs uppercase tracking-wider text-white/55 mb-1">
                      <input
                        type="checkbox"
                        checked={allOn}
                        ref={(el) => {
                          if (el) el.indeterminate = !allOn && someOn;
                        }}
                        onChange={() => toggleCategory(perms)}
                      />
                      {category}
                      <span className="text-white/35 normal-case tracking-normal">
                        {perms.filter((p) => selected.has(p.key)).length}/{perms.length}
                      </span>
                    </label>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 pl-5">
                      {perms.map((p) => (
                        <label
                          key={p.key}
                          className="flex items-center gap-2 text-xs cursor-pointer"
                          title={p.description ?? undefined}
                        >
                          <input
                            type="checkbox"
                            checked={selected.has(p.key)}
                            onChange={() => togglePerm(p.key)}
                          />
                          <span className="font-mono text-white/70">{p.key}</span>
                          <span className="text-white/45">{p.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {role ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-white/55">{label}</label>
      {children}
    </div>
  );
}
