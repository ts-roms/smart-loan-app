import { usePermissionHolders, usePermissions } from "@loan/api-client";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonLine,
} from "@loan/ui";
import { Search, ShieldQuestion } from "lucide-react";
import { useMemo, useState } from "react";

/**
 * Reverse permission lookup panel — "Who currently holds X?".
 *
 * Pick a permission key from the autocomplete; the panel below shows
 * the roles + active delegations granting it, with a deduped active
 * user count. Designed for the audit question "if I remove this
 * permission from `LOAN_OFFICER`, who loses what?".
 */
export function PermissionHoldersPanel() {
  const permissions = usePermissions();
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const holders = usePermissionHolders(selectedKey);

  // Group filtered permissions by category for a readable picker. The
  // catalog is small (~50 keys); no pagination needed.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (permissions.data ?? []).filter((p) =>
      q.length === 0
        ? true
        : p.key.toLowerCase().includes(q) ||
          p.label.toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q),
    );
    const byCategory: Record<string, typeof rows> = {};
    for (const r of rows) {
      const cat = r.category ?? "other";
      byCategory[cat] = byCategory[cat] ?? [];
      byCategory[cat].push(r);
    }
    return byCategory;
  }, [permissions.data, query]);

  return (
    <Card data-tour="permission-holders-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldQuestion className="h-4 w-4 text-info" />
          Who has permission…?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-fg-muted">
          Reverse lookup. Pick a permission key to see every role + active
          delegation that currently grants it, plus the deduped count of unique
          users who hold it right now.
        </p>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-fg-subtle" />
          <input
            type="text"
            placeholder="Search by key, label, or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 text-sm bg-surface-2 border border-default rounded-md outline-none focus:border-info/40"
          />
        </div>

        {permissions.isLoading ? (
          <SkeletonLine />
        ) : (
          <div className="max-h-60 overflow-y-auto rounded-md border border-default divide-y divide-default">
            {Object.entries(groups)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([category, rows]) => (
                <div key={category} className="px-2 py-1">
                  <div className="text-[10px] uppercase tracking-wider text-fg-subtle py-1">
                    {category}
                  </div>
                  <div className="space-y-0.5">
                    {rows.map((p) => (
                      <button
                        type="button"
                        key={p.key}
                        onClick={() => setSelectedKey(p.key)}
                        className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-hover ${
                          selectedKey === p.key ? "bg-info/10 text-info" : ""
                        }`}
                      >
                        <span className="font-mono">{p.key}</span>
                        <span className="ml-2 text-fg-muted">{p.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            {Object.keys(groups).length === 0 && (
              <p className="text-xs text-fg-subtle px-3 py-2">
                No permissions match "{query}".
              </p>
            )}
          </div>
        )}

        {selectedKey && (
          <HoldersResult
            key={selectedKey}
            payload={holders.data}
            isLoading={holders.isLoading}
            errorMsg={holders.isError ? holders.error.message : null}
          />
        )}
      </CardContent>
    </Card>
  );
}

function HoldersResult({
  payload,
  isLoading,
  errorMsg,
}: {
  payload: ReturnType<typeof usePermissionHolders>["data"];
  isLoading: boolean;
  errorMsg: string | null;
}) {
  if (isLoading) return <SkeletonLine />;
  if (errorMsg) {
    return (
      <div className="text-xs text-danger bg-danger/5 border border-danger/20 rounded px-3 py-2">
        {errorMsg}
      </div>
    );
  }
  if (!payload) return null;

  return (
    <div className="space-y-3 rounded-md border border-default bg-surface-2 p-3">
      <div>
        <div className="font-mono text-xs text-info">
          {payload.permission.key}
        </div>
        <div className="text-sm">{payload.permission.label}</div>
        {payload.permission.description && (
          <div className="text-xs text-fg-muted mt-0.5">
            {payload.permission.description}
          </div>
        )}
        <div className="mt-2 text-xs text-fg-muted">
          {payload.totalActiveUsers}{" "}
          {payload.totalActiveUsers === 1 ? "user" : "users"} hold this right
          now (deduped across roles + active delegations).
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
          Direct roles
        </div>
        {payload.directRoles.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No role grants this permission directly.
          </p>
        ) : (
          <ul className="space-y-1">
            {payload.directRoles.map((r) => (
              <li
                key={r.key}
                className="flex items-center justify-between text-xs"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono">{r.key}</span>
                  <Badge variant={r.system ? "muted" : "success"}>
                    {r.system ? "system" : "custom"}
                  </Badge>
                  <span className="text-fg">{r.name}</span>
                </span>
                <span className="text-fg-muted tabular-nums">
                  {r.userCount} {r.userCount === 1 ? "user" : "users"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
          Active delegations
        </div>
        {payload.delegations.length === 0 ? (
          <p className="text-xs text-fg-muted">
            No active delegation grants this permission.
          </p>
        ) : (
          <ul className="space-y-1">
            {payload.delegations.map((d) => (
              <li key={d.id} className="text-xs">
                <span className="text-fg">{d.delegateName}</span>
                <span className="text-fg-subtle"> ← </span>
                <span className="text-fg-muted">{d.delegatorName}</span>
                <span className="text-fg-subtle ml-2">
                  until {new Date(d.endsAt).toLocaleDateString()}
                </span>
                {!d.viaExplicit && (
                  <Badge variant="warning" className="ml-2">
                    inherited
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
