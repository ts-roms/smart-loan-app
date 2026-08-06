import {
  useAssignRole,
  useCreateUser,
  useForceLogout,
  useRoles,
  useUnassignRole,
  useUsers,
  type CreateUserInput,
} from "@loan/api-client";
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
  PasswordInput,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useConfirm,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import { LogOut, Plus, UserCog, UserPlus, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { usePermission } from "../../../hooks/use-permission";
import { useAuth } from "../../../providers/auth";
import { PresenceBadge } from "../components/PresenceBadge";

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
  const forceLogout = useForceLogout();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { user: me } = useAuth();
  const canManage = me?.role === "ADMIN";
  // Its own permission rather than `canManage`: ending a session is
  // meant to be grantable to someone who can't edit users at all.
  const canForceLogout = usePermission("admin.force_logout");
  const [assigning, setAssigning] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const onAssign = async (
    userId: string,
    roleKey: string,
    expiresAt: string | null,
  ) => {
    try {
      await assign.mutateAsync({ userId, roleKey, expiresAt });
      toast.success(
        expiresAt
          ? `Role assigned (expires ${formatDate(expiresAt)})`
          : "Role assigned",
      );
      setAssigning(null);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onUnassign = async (
    userId: string,
    roleKey: string,
    system: boolean,
  ) => {
    const ok = await confirm({
      title: system
        ? `Remove system role ${roleKey}?`
        : `Remove role ${roleKey}?`,
      message: system
        ? `They'll lose all permissions granted by ${roleKey}. This is reversible — you can re-assign the role at any time.`
        : `They'll lose all permissions granted by ${roleKey}.`,
      confirmLabel: "Remove role",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await unassign.mutateAsync({ userId, roleKey });
      toast.success("Role removed");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  /**
   * End every session a user holds.
   *
   * The copy is doing real work here. "Force logout" sounds like
   * deactivation to most people, and an admin who believes they've
   * locked the account will stop looking for the actual off switch —
   * so the dialog says plainly that the user can sign back in, and
   * points at Status for the other thing.
   *
   * A prompt rather than a confirm because the reason is what makes
   * the audit row worth keeping. It's optional: 2am incidents don't
   * wait for paperwork, and blank is better than a forced "asdf".
   */
  const onForceLogout = async (userId: string, name: string, email: string) => {
    const reason = await prompt({
      title: `End all sessions for ${name}?`,
      message: (
        <div className="space-y-2">
          <p>
            Every device <strong>{email}</strong> is signed in on stops working
            immediately, including any access token already issued.
          </p>
          <p className="text-fg-muted">
            This does not disable the account — they can sign in again with the
            same password. To stop that, set their status to Inactive.
          </p>
        </div>
      ),
      label: "Reason (optional)",
      placeholder: "e.g. laptop reported stolen",
      confirmLabel: "End sessions",
    });
    // null = cancelled. An empty string is a deliberate "no reason",
    // and has to be allowed to proceed.
    if (reason === null) return;
    try {
      const res = await forceLogout.mutateAsync({
        userId,
        reason: reason.trim() || undefined,
      });
      toast.success(
        res.refreshTokensRevoked > 0
          ? `${name} signed out — ${res.refreshTokensRevoked} session${res.refreshTokensRevoked === 1 ? "" : "s"} revoked`
          : `${name} signed out`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
        <CardTitle className="flex items-center gap-2">
          <UserCog className="h-4 w-4" />
          Users
        </CardTitle>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <UserPlus className="h-4 w-4" />
            New user
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {users.isLoading ? (
          <SkeletonCard />
        ) : (users.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">No users.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2">Name / Email</th>
                <th className="py-2 px-2">Primary role</th>
                <th className="py-2 px-2">Assigned roles</th>
                <th className="py-2 px-2">Status</th>
                {/* Its own column, not folded into Status. "Active" is
                    whether the account may sign in; "Online" is whether
                    they are here now. One is a permission and the other
                    is an observation, and an admin about to end someone's
                    session needs to read them separately. */}
                <th className="py-2 px-2">Presence</th>
                <th className="py-2 px-2">Created</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className="hover:bg-hover align-top">
                  <td className="py-2 px-2">
                    <div>{u.name}</div>
                    <div className="text-xs text-fg-subtle">{u.email}</div>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant="muted">{u.primaryRole}</Badge>
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length === 0 ? (
                        <span className="text-xs text-fg-subtle">none</span>
                      ) : (
                        u.roles.map((r) => {
                          // Self-lockout: don't show the X on your own ADMIN
                          // role — the API rejects it anyway, this just makes
                          // the UI honest about it.
                          const isSelfAdmin =
                            r.key === "ADMIN" && u.id === me?.id;
                          // Three temporal states for an assignment with an
                          // expiry: still active, expired (row kept for
                          // audit, no perms), or perpetual. The badge style
                          // shifts so admins see the difference at a glance.
                          const expiry = r.expiresAt
                            ? new Date(r.expiresAt)
                            : null;
                          const expired =
                            expiry !== null && expiry.getTime() <= Date.now();
                          return (
                            <span
                              key={r.key}
                              className={
                                expired
                                  ? "inline-flex items-center gap-1 rounded-full border border-default bg-surface-2 px-2 py-0.5 text-xs opacity-50 line-through"
                                  : "inline-flex items-center gap-1 rounded-full border border-default bg-surface-2 px-2 py-0.5 text-xs"
                              }
                              title={
                                expiry
                                  ? expired
                                    ? `Expired ${formatDate(r.expiresAt)} — no longer grants permissions`
                                    : `Expires ${formatDate(r.expiresAt)}`
                                  : undefined
                              }
                            >
                              <span
                                className={
                                  r.system ? "text-info" : "text-success"
                                }
                              >
                                {r.name}
                              </span>
                              {expiry && (
                                <span className="text-[10px] text-warning">
                                  {expired ? "expired" : "until"}{" "}
                                  {formatDate(r.expiresAt)}
                                </span>
                              )}
                              {canManage && !isSelfAdmin && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onUnassign(u.id, r.key, r.system)
                                  }
                                  className="text-fg-subtle hover:text-danger"
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
                    <Badge variant={u.active ? "success" : "muted"}>
                      {u.active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="py-2 px-2">
                    <PresenceBadge
                      presence={u.presence}
                      lastSeenAt={u.lastSeenAt}
                    />
                  </td>
                  <td className="py-2 px-2 text-xs text-fg-muted">
                    {formatDate(u.createdAt)}
                  </td>
                  <td className="py-2 px-2">
                    <div className="flex items-center justify-end gap-2">
                      {canManage && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAssigning(u.id)}
                        >
                          <Plus className="h-3 w-3" />
                          Assign
                        </Button>
                      )}
                      {/*
                        Hidden on your own row rather than shown
                        disabled. The API refuses it anyway, but a
                        greyed-out button invites a hover to find out
                        why, and there is nothing useful to say — you
                        end your own session with Sign out.
                      */}
                      {canForceLogout && u.id !== me?.id && (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={
                            forceLogout.isPending &&
                            forceLogout.variables?.userId === u.id
                          }
                          onClick={() =>
                            void onForceLogout(u.id, u.name, u.email)
                          }
                          title="End every session this user has"
                        >
                          {!forceLogout.isPending && (
                            <LogOut className="h-3 w-3" />
                          )}
                          Sign out
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {creating && <NewUserDialog onClose={() => setCreating(false)} />}
      {assigning && (
        <AssignRoleDialog
          userId={assigning}
          roles={(roles.data ?? []).map((r) => ({
            id: r.id,
            key: r.key,
            name: r.name,
            description: r.description,
            system: r.system,
            permissionCount: r.permissions.length,
          }))}
          onClose={() => setAssigning(null)}
          onPick={onAssign}
        />
      )}
    </Card>
  );
}

interface RoleOption {
  id: string;
  key: string;
  name: string;
  description: string | null;
  system: boolean;
  permissionCount: number;
}

/**
 * Assign-a-role dialog. Two parts:
 *
 *   1. an optional "Temporary grant" checkbox + datetime field at the
 *      top. When unchecked, picking a role creates a perpetual grant
 *      (the historical behaviour). When checked + a future date is
 *      picked, the grant carries `expiresAt` and stops conferring
 *      permissions automatically after that instant.
 *   2. the role list. Click a row to commit the grant with the
 *      currently-configured expiry.
 *
 * The expiry is intentionally a single field shared across role
 * choices — temporary grants are almost always "X is acting role for
 * the next 2 weeks" and forcing per-role re-entry would be busywork.
 */
function AssignRoleDialog({
  userId,
  roles,
  onClose,
  onPick,
}: {
  userId: string;
  roles: RoleOption[];
  onClose: () => void;
  onPick: (
    userId: string,
    roleKey: string,
    expiresAt: string | null,
  ) => void | Promise<void>;
}) {
  const [temporary, setTemporary] = useState(false);
  // datetime-local picker speaks "YYYY-MM-DDTHH:mm" in local time.
  // We translate to an ISO-8601 string at submit time. Default to
  // "two weeks from now" so the field doesn't sit empty — the most
  // common temporary grant duration is 1-2 weeks (acting role coverage).
  const defaultExpiry = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    d.setHours(17, 0, 0, 0);
    // Convert to the local-naive format expected by datetime-local.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  const [expiry, setExpiry] = useState(defaultExpiry);

  const expiresAtIso = (() => {
    if (!temporary) return null;
    const parsed = new Date(expiry);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  })();

  const expiryInPast =
    temporary &&
    expiresAtIso !== null &&
    new Date(expiresAtIso).getTime() <= Date.now();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign a role</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border border-default bg-surface-2 p-3 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={temporary}
                onChange={(e) => setTemporary(e.target.checked)}
              />
              Temporary grant — expires at a set time
            </label>
            {temporary && (
              <div className="space-y-1">
                <Label className="text-xs">Expires at</Label>
                <Input
                  type="datetime-local"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
                <p className="text-[10px] text-fg-subtle">
                  After this instant the role stops conferring permissions. The
                  assignment row stays in place for audit; you can re-assign to
                  extend.
                </p>
                {expiryInPast && (
                  <p className="text-[10px] text-danger">
                    Expiry must be in the future.
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {roles.map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={temporary && (expiresAtIso === null || expiryInPast)}
                onClick={() => onPick(userId, r.key, expiresAtIso)}
                className="w-full text-left rounded-md border border-default bg-surface-2 hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <span>{r.name}</span>
                  <Badge variant={r.system ? "muted" : "success"}>
                    {r.system ? "System" : "Custom"}
                  </Badge>
                </div>
                {r.description && (
                  <div className="text-xs text-fg-subtle mt-0.5">
                    {r.description}
                  </div>
                )}
                <div className="text-xs text-fg-subtle mt-0.5">
                  {r.permissionCount} permission
                  {r.permissionCount === 1 ? "" : "s"}
                </div>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin "new user" dialog. Collects the minimum a user needs to log in
 * (email, name, password) plus the primary role. CUSTOMER role gets an
 * extra "link to existing customer" field — leaving it blank creates a
 * standalone account that can be linked later.
 *
 * Password is set here (not emailed). Operators should communicate it
 * to the new user out-of-band and ask them to change it on first login
 * (no "force password change" flag yet — track in a follow-up).
 */
function NewUserDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateUser();
  const toast = useToast();
  const [form, setForm] = useState<CreateUserInput>({
    email: "",
    name: "",
    password: "",
    role: "LOAN_OFFICER",
    customerId: undefined,
  });

  const set = <K extends keyof CreateUserInput>(
    key: K,
    val: CreateUserInput[K],
  ) => setForm((f) => ({ ...f, [key]: val }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const payload: CreateUserInput = {
        email: form.email.trim(),
        name: form.name.trim(),
        password: form.password,
        role: form.role,
      };
      // Only send customerId when role is CUSTOMER + the field has a value.
      // Server rejects the combo otherwise but the round-trip is wasted.
      if (form.role === "CUSTOMER" && form.customerId?.trim()) {
        payload.customerId = form.customerId.trim();
      }
      await create.mutateAsync(payload);
      toast.success("User created");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not create user");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            New user
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                required
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Initial password</Label>
              <PasswordInput
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="8+ characters"
              />
              <p className="text-[10px] text-fg-subtle">
                Communicate this to the user out-of-band. Recommend they change
                it on first login.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Primary role</Label>
              <Select
                value={form.role}
                onValueChange={(v) => set("role", v as CreateUserInput["role"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADMIN">ADMIN</SelectItem>
                  <SelectItem value="LOAN_OFFICER">LOAN_OFFICER</SelectItem>
                  <SelectItem value="ACCOUNTANT">ACCOUNTANT</SelectItem>
                  <SelectItem value="CUSTOMER">CUSTOMER</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.role === "CUSTOMER" && (
              <div className="space-y-1">
                <Label>Linked customer ID (optional)</Label>
                <Input
                  value={form.customerId ?? ""}
                  onChange={(e) => set("customerId", e.target.value)}
                  placeholder="UUID — leave blank to link later"
                />
                <p className="text-[10px] text-fg-subtle">
                  Required for portal access. Find the id on the customer detail
                  page.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
