import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { btnSecondary } from "../App";
import { makeApi, useAuth } from "../AuthProvider";

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  licenseSnapshot: {
    tier?: string;
    exp?: number;
    features?: string[];
    seats?: number;
  } | null;
}

export function TenantDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { user, token } = useAuth();
  const api = makeApi(token);
  const qc = useQueryClient();
  const isAdmin = user?.role === "PLATFORM_ADMIN";

  const { data, isLoading } = useQuery({
    queryKey: ["platform", "tenant", slug],
    queryFn: () => api<Tenant>(`/platform/tenants/${slug}`),
    enabled: Boolean(slug),
  });

  const action = useMutation({
    mutationFn: (op: "suspend" | "restore" | "archive") =>
      api(`/platform/tenants/${slug}/${op}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform", "tenant", slug] });
      qc.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
  });

  if (isLoading) return <p style={{ color: "#94a3b8" }}>Loading…</p>;
  if (!data) return <p style={{ color: "#fca5a5" }}>Tenant not found.</p>;

  return (
    <div>
      <Link to="/tenants" style={{ color: "#60a5fa", fontSize: 13 }}>
        ← Tenants
      </Link>
      <h1 style={{ fontSize: 22, margin: "12px 0 4px" }}>{data.name}</h1>
      <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 24 }}>
        <code>{data.slug}</code> · {data.status}
      </div>

      <section style={card}>
        <h2 style={h2}>License snapshot</h2>
        {data.licenseSnapshot ? (
          <dl style={{ margin: 0 }}>
            <Field
              label="Tier"
              value={String(data.licenseSnapshot.tier ?? "—")}
            />
            <Field
              label="Expires"
              value={
                data.licenseSnapshot.exp
                  ? new Date(data.licenseSnapshot.exp).toLocaleString()
                  : "—"
              }
            />
            <Field
              label="Seats"
              value={
                data.licenseSnapshot.seats === 0
                  ? "Unlimited"
                  : String(data.licenseSnapshot.seats ?? "—")
              }
            />
            <Field
              label="Features"
              value={String(data.licenseSnapshot.features?.length ?? 0)}
            />
          </dl>
        ) : (
          <p style={{ fontSize: 13, color: "#94a3b8" }}>
            No license issued yet for this tenant.
          </p>
        )}
        <Link
          to={`/licenses/issue?tenant=${data.slug}`}
          style={{
            display: "inline-block",
            marginTop: 12,
            color: "#60a5fa",
            fontSize: 13,
          }}
        >
          Issue a license for this tenant →
        </Link>
      </section>

      {isAdmin && (
        <section style={card}>
          <h2 style={h2}>Lifecycle</h2>
          <p style={{ fontSize: 13, color: "#94a3b8", marginTop: 0 }}>
            Suspended tenants keep their data but the tenant API returns 503.
            Archived tenants are soft-deleted (data retained, never served).
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {data.status !== "ACTIVE" && data.status !== "ARCHIVED" && (
              <button
                onClick={() => action.mutate("restore")}
                style={btnSecondary}
                disabled={action.isPending}
              >
                Restore (→ ACTIVE)
              </button>
            )}
            {data.status === "ACTIVE" && (
              <button
                onClick={() => action.mutate("suspend")}
                style={btnSecondary}
                disabled={action.isPending}
              >
                Suspend
              </button>
            )}
            {data.status !== "ARCHIVED" && (
              <button
                onClick={() => {
                  if (
                    confirm(
                      `Archive "${data.name}"? Data is retained but the tenant won't be served.`,
                    )
                  ) {
                    action.mutate("archive");
                  }
                }}
                style={{
                  ...btnSecondary,
                  borderColor: "#7f1d1d",
                  color: "#fca5a5",
                }}
                disabled={action.isPending}
              >
                Archive
              </button>
            )}
          </div>
        </section>
      )}

      <section style={card}>
        <h2 style={h2}>Metadata</h2>
        <Field
          label="Created"
          value={new Date(data.createdAt).toLocaleString()}
        />
        <Field
          label="Last seen"
          value={
            data.lastSeenAt
              ? new Date(data.lastSeenAt).toLocaleString()
              : "Never"
          }
        />
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", margin: "6px 0", fontSize: 14 }}>
      <div style={{ width: 120, color: "#94a3b8" }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "#0e1525",
  border: "1px solid #1e293b",
  borderRadius: 8,
  padding: 20,
  marginBottom: 16,
};
const h2: React.CSSProperties = { fontSize: 14, margin: "0 0 12px" };
