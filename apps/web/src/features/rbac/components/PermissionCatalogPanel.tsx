import { usePermissions, useSetPermissionStatus } from "@loan/api-client";
import type { Permission, PermissionStatus } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { ListChecks, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { useAuth } from "../../../providers/auth";

/**
 * Permission catalog admin. Lists every permission grouped by
 * category, with a status pill admins can click to advance the
 * lifecycle (DRAFT → ACTIVE → DEPRECATED). The Roles editor still
 * controls which roles hold which permissions; this panel only
 * controls whether each permission "fires" at resolve time.
 *
 * Use cases:
 *
 *   - DRAFT: pre-stage a perm that isn't wired into any feature gate
 *     yet, attach it to roles, then flip to ACTIVE once the
 *     middleware ships
 *   - DEPRECATED: mark a perm for removal — still effective so
 *     in-flight flows don't break, but the UI surfaces a "Cleanup
 *     pending" badge so admins remember to remove it from role sets
 */
export function PermissionCatalogPanel() {
  const { data, isLoading } = usePermissions();
  const setStatus = useSetPermissionStatus();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | PermissionStatus>("all");

  const grouped = useMemo(() => {
    const rows = (data ?? []).filter((p) => {
      if (filter !== "all" && p.status !== filter) return false;
      if (!q.trim()) return true;
      const needle = q.trim().toLowerCase();
      return (
        p.key.toLowerCase().includes(needle) ||
        p.label.toLowerCase().includes(needle) ||
        (p.description ?? "").toLowerCase().includes(needle)
      );
    });
    const map = new Map<string, Permission[]>();
    for (const p of rows) {
      const arr = map.get(p.category) ?? [];
      arr.push(p);
      map.set(p.category, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data, q, filter]);

  const counts = useMemo(() => {
    const initial: Record<PermissionStatus, number> = {
      DRAFT: 0,
      ACTIVE: 0,
      DEPRECATED: 0,
    };
    for (const p of data ?? []) initial[p.status] += 1;
    return initial;
  }, [data]);

  const flip = async (p: Permission, next: PermissionStatus) => {
    if (next === p.status) return;
    if (next === "DRAFT") {
      const ok = await confirm({
        title: `Mark ${p.key} as DRAFT?`,
        message:
          "DRAFT permissions are not granted at resolve time. Anyone who currently holds this perm via a role will effectively lose it until you flip back to ACTIVE.",
        confirmLabel: "Mark DRAFT",
        tone: "destructive",
      });
      if (!ok) return;
    }
    try {
      await setStatus.mutateAsync({ key: p.key, status: next });
      toast.success(`${p.key} → ${next}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Card data-tour="permission-catalog-panel">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-sky-300" />
          Permission catalog
        </CardTitle>
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="muted">{counts.DRAFT} draft</Badge>
          <Badge variant="success">{counts.ACTIVE} active</Badge>
          <Badge variant="danger">{counts.DEPRECATED} deprecated</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[12rem]">
            <Search className="absolute left-2 top-2.5 h-3 w-3 text-fg-subtle pointer-events-none" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by key, label, description"
              className="pl-7 h-8"
            />
          </div>
          <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-xs">
            {(["all", "DRAFT", "ACTIVE", "DEPRECATED"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={
                  filter === f
                    ? "px-2.5 py-1 bg-white/[0.08] text-fg"
                    : "px-2.5 py-1 hover:bg-white/[0.04] text-fg-muted"
                }
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <SkeletonCard />
        ) : grouped.length === 0 ? (
          <p className="text-sm text-fg-muted">No permissions match.</p>
        ) : (
          <div className="space-y-3">
            {grouped.map(([category, perms]) => (
              <div key={category}>
                <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
                  {category}
                </div>
                <ul className="space-y-1">
                  {perms.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-white/8 bg-white/[0.02] px-2 py-1.5"
                    >
                      <code className="text-xs">{p.key}</code>
                      <span className="text-xs text-fg-muted">{p.label}</span>
                      <div className="ml-auto flex items-center gap-1">
                        <StatusBadge status={p.status} />
                        {isAdmin && (
                          <div className="flex gap-1">
                            {(["DRAFT", "ACTIVE", "DEPRECATED"] as const)
                              .filter((s) => s !== p.status)
                              .map((s) => (
                                <Button
                                  key={s}
                                  size="sm"
                                  variant="outline"
                                  disabled={setStatus.isPending}
                                  onClick={() => flip(p, s)}
                                >
                                  → {s}
                                </Button>
                              ))}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] text-fg-subtle">
          DRAFT keys are skipped by the permission resolver — anyone who holds
          the perm via a role won't actually receive it. DEPRECATED still grants
          at runtime so existing flows don't break.
        </p>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: PermissionStatus }) {
  if (status === "ACTIVE") return <Badge variant="success">ACTIVE</Badge>;
  if (status === "DRAFT") return <Badge variant="muted">DRAFT</Badge>;
  return <Badge variant="danger">DEPRECATED</Badge>;
}
