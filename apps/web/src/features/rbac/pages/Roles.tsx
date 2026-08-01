import {
  useCreateRole,
  useDeleteRole,
  usePermissions,
  useRoleEditImpact,
  useRoles,
  useUpdateRole,
} from "@loan/api-client";
import type {
  Permission,
  RoleEditImpact,
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
  Input,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { useAuth } from "../../../providers/auth";
import { findArticle, TourButton } from "../../help";
import { PermissionCatalogPanel } from "../components/PermissionCatalogPanel";
import { PermissionHoldersPanel } from "../components/PermissionHoldersPanel";

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
  const isAdmin = user?.role === "ADMIN";
  const [editing, setEditing] = useState<RoleWithPermissions | null>(null);
  const [creating, setCreating] = useState(false);

  const onDelete = async (r: RoleWithPermissions) => {
    if (r.system) {
      toast.error("System roles cannot be deleted.");
      return;
    }
    const assignedCount = r._count?.users ?? 0;
    const ok = await confirm({
      title: `Delete role "${r.name}"?`,
      message:
        assignedCount > 0
          ? `This role is currently assigned to ${assignedCount} user${assignedCount === 1 ? "" : "s"}. They'll lose every permission this role grants.`
          : "This is reversible only by re-creating the role from scratch.",
      confirmLabel: "Delete role",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(r.key);
      toast.success("Role deleted");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <div className="space-y-4">
      <PermissionHoldersPanel />
      <PermissionCatalogPanel />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-sky-300" />
            Roles & permissions
          </CardTitle>
          <div className="flex items-center gap-2">
            <TourButton tourId="rbac" steps={findArticle("rbac")?.tour ?? []} />
            {isAdmin && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                New role
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/55 mb-3">
            Each role is a collection of fine-grained permissions. Users can
            hold multiple roles; their effective permissions are the union
            across all of them.
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
                        <div className="text-xs text-white/45">
                          {r.description}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {r.permissions.length}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {r._count?.users ?? 0}
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant={r.system ? "muted" : "success"}>
                        {r.system ? "System" : "Custom"}
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
    </div>
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
  const impactCheck = useRoleEditImpact();
  const allRoles = useRoles();
  const toast = useToast();
  const [key, setKey] = useState(role?.key ?? "");
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(role?.permissions.map((rp) => rp.permission.key) ?? []),
  );
  // Inheritance: keys of roles whose perms this role unions in at
  // resolve time. Excludes the role itself (server filters too).
  const [parents, setParents] = useState<Set<string>>(
    new Set(role?.parents?.map((p) => p.parent.key) ?? []),
  );
  // When the impact check finds at-risk users, stage the impact here
  // and freeze the dialog while a confirmation modal asks the admin
  // "really?". `null` means "no pending confirmation; submit goes
  // straight through".
  const [pendingImpact, setPendingImpact] = useState<RoleEditImpact | null>(
    null,
  );

  // Group the catalog by category for the matrix UI.
  const grouped = useMemo(() => {
    const byCategory = new Map<string, Permission[]>();
    for (const p of allPermissions) {
      (
        byCategory.get(p.category) ??
        byCategory.set(p.category, []).get(p.category)!
      ).push(p);
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

  /**
   * Commit the update without a further preview. Called either
   * directly (no removals / no at-risk users) or after the admin
   * confirms the impact dialog.
   */
  const persist = async () => {
    try {
      if (role) {
        await update.mutateAsync({
          key: role.key,
          name,
          description: description || undefined,
          permissions: [...selected],
          parents: [...parents],
        });
        toast.success("Role saved");
      } else {
        await create.mutateAsync({
          key,
          name,
          description: description || undefined,
          permissions: [...selected],
          parents: [...parents],
        });
        toast.success(`Role ${key} created`);
      }
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Edits only: ask the API what changes between the saved set and
    // the current draft. Removed perms with `usersLosing > 0` mean
    // active users will silently lose access — surface a confirmation
    // dialog before the write. Creates skip this entirely (no prior
    // assignments to consider).
    if (role) {
      try {
        const impact = await impactCheck.mutateAsync({
          roleKey: role.key,
          permissions: [...selected],
        });
        const anyAtRisk = impact.removed.some((r) => r.usersLosing > 0);
        if (anyAtRisk) {
          setPendingImpact(impact);
          return;
        }
      } catch (err) {
        // If the impact check itself fails, fall through to the
        // optimistic save — the server still enforces invariants;
        // we just lose the warning UX.

        console.warn("Role edit-impact check failed; proceeding to save", err);
      }
    }
    await persist();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{role ? `Edit ${role.name}` : "New role"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key (UPPER_SNAKE)">
              <Input
                value={key}
                onChange={(e) =>
                  setKey(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""),
                  )
                }
                placeholder="BRANCH_MANAGER"
                disabled={!!role}
                required
              />
            </Field>
            <Field label="Display name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
          </div>
          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div className="rounded-md border border-white/10">
            <div className="px-3 py-2 text-xs uppercase tracking-wider text-white/45 border-b border-white/10 flex items-center justify-between">
              <span>Inherits from ({parents.size})</span>
              {parents.size > 0 && (
                <button
                  type="button"
                  onClick={() => setParents(new Set())}
                  className="text-sky-300 hover:underline normal-case tracking-normal"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="p-2 max-h-40 overflow-y-auto grid grid-cols-2 gap-x-3 gap-y-1">
              {(allRoles.data ?? [])
                // A role can't inherit from itself. The server enforces
                // this too, but filtering client-side keeps the option
                // out of the UI entirely.
                .filter((r) => r.key !== role?.key)
                .map((r) => (
                  <label
                    key={r.id}
                    className="flex items-center gap-2 text-xs cursor-pointer"
                    title={r.description ?? undefined}
                  >
                    <input
                      type="checkbox"
                      checked={parents.has(r.key)}
                      onChange={() => {
                        const next = new Set(parents);
                        if (next.has(r.key)) next.delete(r.key);
                        else next.add(r.key);
                        setParents(next);
                      }}
                    />
                    <span className="font-mono text-white/70">{r.key}</span>
                    <span className="text-white/45">{r.name}</span>
                  </label>
                ))}
              {(allRoles.data ?? []).length === 0 && (
                <span className="text-xs text-white/45">
                  No other roles yet.
                </span>
              )}
            </div>
            <div className="px-3 py-1.5 text-[10px] text-white/45 border-t border-white/10">
              At resolve time, this role's effective permission set is the union
              of its own permissions and every parent's (recursively). Cycles
              are rejected on save.
            </div>
          </div>

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
                {selected.size === allPermissions.length
                  ? "Deselect all"
                  : "Select all"}
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
                        {perms.filter((p) => selected.has(p.key)).length}/
                        {perms.length}
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
                          <span className="font-mono text-white/70">
                            {p.key}
                          </span>
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
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                create.isPending || update.isPending || impactCheck.isPending
              }
            >
              {role
                ? impactCheck.isPending
                  ? "Checking impact…"
                  : "Save"
                : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      {pendingImpact && (
        <ImpactConfirmDialog
          impact={pendingImpact}
          isSaving={update.isPending}
          onCancel={() => setPendingImpact(null)}
          onConfirm={async () => {
            setPendingImpact(null);
            await persist();
          }}
        />
      )}
    </Dialog>
  );
}

/**
 * Confirmation dialog rendered when the impact check finds at-risk
 * users. Lists each permission being removed alongside the
 * (this-role-is-their-only-grant) user count. The admin has to
 * explicitly confirm before the actual write fires — saves them from
 * silently dropping permissions for a dozen people.
 */
function ImpactConfirmDialog({
  impact,
  isSaving,
  onCancel,
  onConfirm,
}: {
  impact: RoleEditImpact;
  isSaving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const atRisk = impact.removed.filter((r) => r.usersLosing > 0);
  const totalUsersHit = atRisk.reduce((sum, r) => sum + r.usersLosing, 0);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-amber-200">
            Confirm role-edit impact
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-white/70">
            Saving this update removes the following permissions from{" "}
            <span className="font-mono text-white/85">{impact.role.key}</span>.
            Active users for whom this role is the only grant will lose access
            immediately.
          </p>
          <ul className="space-y-1.5 rounded-md border border-amber-400/30 bg-amber-500/[0.04] p-3">
            {atRisk.map((r) => (
              <li
                key={r.key}
                className="flex items-center justify-between text-xs"
              >
                <span>
                  <span className="font-mono text-amber-200">{r.key}</span>
                  <span className="ml-2 text-white/70">{r.label}</span>
                </span>
                <span className="tabular-nums text-amber-200">
                  {r.usersLosing}{" "}
                  {r.usersLosing === 1
                    ? "user loses access"
                    : "users lose access"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-white/55">
            Up to {totalUsersHit} permission-grant{" "}
            {totalUsersHit === 1 ? "removal" : "removals"} across affected
            users. A user is counted once per removed permission if this role is
            their only grant for that key.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isSaving}>
            {isSaving ? "Saving…" : "Save anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-white/55">{label}</label>
      {children}
    </div>
  );
}
