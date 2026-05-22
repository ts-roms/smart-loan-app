import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { makeApi, useAuth } from "../AuthProvider";

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  createdAt: string;
  lastSeenAt: string | null;
  licenseSnapshot: { tier?: string; exp?: number } | null;
}

export function TenantsList() {
  const { token } = useAuth();
  const api = makeApi(token);
  const { data, isLoading, error } = useQuery({
    queryKey: ["platform", "tenants"],
    queryFn: () => api<Tenant[]>("/platform/tenants"),
  });

  return (
    <div>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 24,
        }}
      >
        <h1 style={{ fontSize: 22, margin: 0 }}>Tenants</h1>
        <Link
          to="/licenses/issue"
          style={{
            background: "#3b82f6",
            color: "white",
            padding: "8px 16px",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: 14,
          }}
        >
          Issue license
        </Link>
      </header>

      {isLoading && <p style={{ color: "#94a3b8" }}>Loading…</p>}
      {error && (
        <p style={{ color: "#fca5a5" }}>Failed: {(error as Error).message}</p>
      )}

      {data && data.length === 0 && (
        <div
          style={{
            padding: 32,
            border: "1px dashed #334155",
            borderRadius: 8,
            textAlign: "center",
            color: "#94a3b8",
          }}
        >
          No tenants yet. Provision the first one — they show up here once the
          API returns from creation.
        </div>
      )}

      {data && data.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: 12, color: "#94a3b8" }}>
              <th style={th}>Tenant</th>
              <th style={th}>Slug</th>
              <th style={th}>Status</th>
              <th style={th}>Tier</th>
              <th style={th}>License expires</th>
              <th style={th}>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id} style={{ borderTop: "1px solid #1e293b" }}>
                <td style={td}>
                  <Link
                    to={`/tenants/${t.slug}`}
                    style={{ color: "#60a5fa", textDecoration: "none" }}
                  >
                    {t.name}
                  </Link>
                </td>
                <td style={{ ...td, fontFamily: "monospace" }}>{t.slug}</td>
                <td style={td}>
                  <StatusBadge status={t.status} />
                </td>
                <td style={td}>{t.licenseSnapshot?.tier ?? "—"}</td>
                <td style={td}>
                  {t.licenseSnapshot?.exp
                    ? new Date(t.licenseSnapshot.exp).toLocaleDateString()
                    : "—"}
                </td>
                <td style={{ ...td, color: "#64748b" }}>
                  {t.lastSeenAt
                    ? new Date(t.lastSeenAt).toLocaleString()
                    : "never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Tenant["status"] }) {
  const colors: Record<Tenant["status"], string> = {
    ACTIVE: "#10b981",
    PROVISIONING: "#f59e0b",
    SUSPENDED: "#ef4444",
    ARCHIVED: "#64748b",
  };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        background: `${colors[status]}20`,
        color: colors[status],
        border: `1px solid ${colors[status]}40`,
      }}
    >
      {status}
    </span>
  );
}

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
