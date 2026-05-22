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
      byCategory[cat]!.push(r);
    }
    return byCategory;
  }, [permissions.data, query]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldQuestion className="h-4 w-4 text-sky-300" />
          Who has permission…?
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-white/55">
          Reverse lookup. Pick a permission key to see every role + active
          delegation that currently grants it, plus the deduped count of unique
          users who hold it right now.
        </p>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white/45" />
          <input
            type="text"
            placeholder="Search by key, label, or description…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-7 pr-3 py-1.5 text-sm bg-white/5 border border-white/10 rounded-md outline-none focus:border-sky-400/40"
          />
        </div>

        {permissions.isLoading ? (
          <SkeletonLine />
        ) : (
          <div className="max-h-60 overflow-y-auto rounded-md border border-white/5 divide-y divide-white/5">
            {Object.entries(groups)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([category, rows]) => (
                <div key={category} className="px-2 py-1">
                  <div className="text-[10px] uppercase tracking-wider text-white/45 py-1">
                    {category}
                  </div>
                  <div className="space-y-0.5">
                    {rows.map((p) => (
                      <button
                        type="button"
                        key={p.key}
                        onClick={() => setSelectedKey(p.key)}
                        className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-white/[0.04] ${
                          selectedKey === p.key
                            ? "bg-sky-400/10 text-sky-200"
                            : ""
                        }`}
                      >
                        <span className="font-mono">{p.key}</span>
                        <span className="ml-2 text-white/55">{p.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            {Object.keys(groups).length === 0 && (
              <p className="text-xs text-white/45 px-3 py-2">
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
            errorMsg={holders.isError ? (holders.error as Error).message : null}
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
      <div className="text-xs text-rose-300 bg-rose-500/5 border border-rose-500/20 rounded px-3 py-2">
        {errorMsg}
      </div>
    );
  }
  if (!payload) return null;

  return (
    <div className="space-y-3 rounded-md border border-white/10 bg-white/[0.02] p-3">
      <div>
        <div className="font-mono text-xs text-sky-200">
          {payload.permission.key}
        </div>
        <div className="text-sm">{payload.permission.label}</div>
        {payload.permission.description && (
          <div className="text-xs text-white/55 mt-0.5">
            {payload.permission.description}
          </div>
        )}
        <div className="mt-2 text-xs text-white/55">
          {payload.totalActiveUsers}{" "}
          {payload.totalActiveUsers === 1 ? "user" : "users"} hold this right
          now (deduped across roles + active delegations).
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1">
          Direct roles
        </div>
        {payload.directRoles.length === 0 ? (
          <p className="text-xs text-white/55">
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
                  <span className="text-white/70">{r.name}</span>
                </span>
                <span className="text-white/55 tabular-nums">
                  {r.userCount} {r.userCount === 1 ? "user" : "users"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1">
          Active delegations
        </div>
        {payload.delegations.length === 0 ? (
          <p className="text-xs text-white/55">
            No active delegation grants this permission.
          </p>
        ) : (
          <ul className="space-y-1">
            {payload.delegations.map((d) => (
              <li key={d.id} className="text-xs">
                <span className="text-white/70">{d.delegateName}</span>
                <span className="text-white/40"> ← </span>
                <span className="text-white/55">{d.delegatorName}</span>
                <span className="text-white/40 ml-2">
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
