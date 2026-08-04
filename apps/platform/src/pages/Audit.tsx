import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { inputStyle } from "../App";
import { makeApi, useAuth } from "../AuthProvider";

/**
 * Platform-side audit log viewer. Reads PlatformAuditLog (separate
 * from per-tenant AuditLog) and shows who did what on the control
 * plane. PLATFORM_ADMIN only — the route guard on the API enforces
 * it; we just hide the nav entry for SALES.
 *
 * Filters are URL-bound so links from TenantDetail ("see audit for
 * this tenant") deep-link cleanly.
 */
interface AuditRow {
  id: string;
  action: string;
  actorId: string;
  actorEmail: string;
  tenantSlug: string | null;
  payload: unknown;
  createdAt: string;
}

const KNOWN_ACTIONS = [
  "PLATFORM_TENANT_PROVISION",
  "PLATFORM_TENANT_ACTIVE",
  "PLATFORM_TENANT_SUSPENDED",
  "PLATFORM_TENANT_ARCHIVED",
  "PLATFORM_LICENSE_ISSUE",
  "PLATFORM_LICENSE_REVOKE",
];

export function Audit() {
  const { token } = useAuth();
  const api = makeApi(token);
  const [params, setParams] = useSearchParams();
  const tenantSlug = params.get("tenantSlug") ?? "";
  const action = params.get("action") ?? "";

  // Local form state so typing in the slug filter doesn't refetch on
  // every keystroke. Commit on Enter / blur.
  const [slugDraft, setSlugDraft] = useState(tenantSlug);

  const query = useQuery({
    queryKey: ["platform", "audit", { tenantSlug, action }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (tenantSlug) qs.set("tenantSlug", tenantSlug);
      if (action) qs.set("action", action);
      qs.set("limit", "200");
      return api<AuditRow[]>(`/platform/audit?${qs}`);
    },
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const commitSlug = () => {
    if (slugDraft !== tenantSlug) setFilter("tenantSlug", slugDraft);
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, margin: "0 0 16px" }}>Audit log</h1>
      <p style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 20px" }}>
        Every platform-side action — tenant lifecycle, license issuance, license
        revocation. Append-only.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Tenant slug</label>
          <input
            value={slugDraft}
            onChange={(e) => setSlugDraft(e.target.value)}
            onBlur={commitSlug}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSlug();
            }}
            placeholder="(any)"
            style={inputStyle}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Action</label>
          <select
            value={action}
            onChange={(e) => setFilter("action", e.target.value)}
            style={inputStyle}
          >
            <option value="">(any)</option>
            {KNOWN_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      {query.isLoading && <p style={{ color: "var(--text-dim)" }}>Loading…</p>}
      {query.error && (
        <p style={{ color: "var(--danger)" }}>Failed: {query.error.message}</p>
      )}

      {query.data && query.data.length === 0 && (
        <div
          style={{
            padding: 32,
            border: "1px dashed var(--border-strong)",
            borderRadius: 8,
            textAlign: "center",
            color: "var(--text-dim)",
          }}
        >
          No audit entries match these filters.
        </div>
      )}

      {query.data && query.data.length > 0 && (
        <div className="pf-tablewrap">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  fontSize: 12,
                  color: "var(--text-dim)",
                }}
              >
                <th style={th}>When</th>
                <th style={th}>Action</th>
                <th style={th}>Actor</th>
                <th style={th}>Tenant</th>
                <th style={th}>Payload</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((row) => (
                <AuditEntry key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AuditEntry({ row }: { row: AuditRow }) {
  const payloadJson = useMemo(
    () => JSON.stringify(row.payload, null, 2),
    [row.payload],
  );
  return (
    <tr style={{ borderTop: "1px solid var(--border)", verticalAlign: "top" }}>
      <td style={{ ...td, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
        {new Date(row.createdAt).toLocaleString()}
      </td>
      <td style={td}>
        <ActionBadge action={row.action} />
      </td>
      <td style={{ ...td, fontSize: 12 }}>{row.actorEmail}</td>
      <td style={{ ...td, fontFamily: "monospace", fontSize: 12 }}>
        {row.tenantSlug ? (
          <Link
            to={`/tenants/${row.tenantSlug}`}
            style={{ color: "var(--accent)", textDecoration: "none" }}
          >
            {row.tenantSlug}
          </Link>
        ) : (
          <span style={{ color: "var(--text-faint)" }}>—</span>
        )}
      </td>
      <td style={{ ...td, fontFamily: "monospace", fontSize: 11 }}>
        <details>
          <summary style={{ cursor: "pointer", color: "var(--text-dim)" }}>
            view
          </summary>
          <pre
            style={{
              margin: "4px 0 0",
              padding: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              maxWidth: 400,
              overflowX: "auto",
            }}
          >
            {payloadJson}
          </pre>
        </details>
      </td>
    </tr>
  );
}

function ActionBadge({ action }: { action: string }) {
  // Color by intent: blue=create, amber=lifecycle, green=issue, red=destroy.
  const intent = action.includes("REVOKE")
    ? "var(--danger)"
    : action.includes("ARCHIVED")
      ? "var(--danger)"
      : action.includes("SUSPENDED")
        ? "var(--warning)"
        : action.includes("PROVISION")
          ? "var(--accent-strong)"
          : action.includes("ISSUE")
            ? "var(--success)"
            : action.includes("ACTIVE")
              ? "var(--success)"
              : "var(--text-muted)";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        background: `${intent}20`,
        color: intent,
        border: `1px solid ${intent}40`,
      }}
    >
      {action}
    </span>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--text-dim)",
  marginBottom: 4,
};
const th: React.CSSProperties = {
  padding: "8px 12px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "12px",
  fontSize: 14,
};
