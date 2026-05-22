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
    jti?: string;
    tier?: string;
    exp?: number;
    features?: string[];
    seats?: number;
  } | null;
}

interface IssuedLicense {
  id: string;
  jti: string;
  tenantSlug: string;
  tenantName: string;
  tier: string;
  issuedAt: string;
  expiresAt: string;
  seats: number;
  notes: string | null;
  issuedByEmail: string;
  revokedAt: string | null;
  revokedReason: string | null;
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

  const licenses = useQuery({
    queryKey: ["platform", "tenant", slug, "licenses"],
    queryFn: () => api<IssuedLicense[]>(`/platform/tenants/${slug}/licenses`),
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

  const revoke = useMutation({
    mutationFn: ({ jti, reason }: { jti: string; reason?: string }) =>
      api(`/platform/licenses/${jti}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform", "tenant", slug] });
      qc.invalidateQueries({
        queryKey: ["platform", "tenant", slug, "licenses"],
      });
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

      <section style={card}>
        <h2 style={h2}>License history</h2>
        <p style={{ fontSize: 12, color: "#64748b", marginTop: 0 }}>
          Every license issued for this tenant. Revoke is platform-side only —
          the signed token still validates on tenant instances until its expiry.
          In practice: revoke, then issue a fresh token with new terms.
        </p>
        {licenses.isLoading && (
          <p style={{ fontSize: 13, color: "#94a3b8" }}>Loading…</p>
        )}
        {licenses.data && licenses.data.length === 0 && (
          <p style={{ fontSize: 13, color: "#94a3b8" }}>
            No licenses have been issued yet.
          </p>
        )}
        {licenses.data && licenses.data.length > 0 && (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", color: "#94a3b8", fontSize: 11 }}>
                <th style={th}>Issued</th>
                <th style={th}>Tier</th>
                <th style={th}>Expires</th>
                <th style={th}>Status</th>
                <th style={th}>By</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {licenses.data.map((lic) => (
                <LicenseRow
                  key={lic.id}
                  lic={lic}
                  isCurrent={data.licenseSnapshot?.jti === lic.jti}
                  canRevoke={isAdmin}
                  pending={revoke.isPending}
                  onRevoke={(reason) => revoke.mutate({ jti: lic.jti, reason })}
                />
              ))}
            </tbody>
          </table>
        )}
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
        {isAdmin && (
          <div style={{ marginTop: 12 }}>
            <Link
              to={`/audit?tenantSlug=${data.slug}`}
              style={{ color: "#60a5fa", fontSize: 13 }}
            >
              View audit log for this tenant →
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

function LicenseRow({
  lic,
  isCurrent,
  canRevoke,
  pending,
  onRevoke,
}: {
  lic: IssuedLicense;
  isCurrent: boolean;
  canRevoke: boolean;
  pending: boolean;
  onRevoke: (reason: string | undefined) => void;
}) {
  const now = Date.now();
  const expired = Date.parse(lic.expiresAt) < now;
  const status: { label: string; color: string } = lic.revokedAt
    ? { label: "REVOKED", color: "#ef4444" }
    : expired
      ? { label: "EXPIRED", color: "#64748b" }
      : isCurrent
        ? { label: "ACTIVE", color: "#10b981" }
        : { label: "SUPERSEDED", color: "#94a3b8" };

  // Prefill the IssueLicense form for renewal with the same tenant +
  // tier + seats + notes. Expiry stays at the default (1 year forward)
  // since the whole point of renewing is a new expiry.
  const renewHref = new URLSearchParams({
    tenant: lic.tenantSlug,
    tenantName: lic.tenantName,
    tier: lic.tier,
    seats: String(lic.seats),
    ...(lic.notes ? { notes: lic.notes } : {}),
  }).toString();

  return (
    <tr
      style={{
        borderTop: "1px solid #1e293b",
        opacity: lic.revokedAt || expired ? 0.7 : 1,
      }}
    >
      <td style={td}>
        {new Date(lic.issuedAt).toLocaleDateString()}{" "}
        <span style={{ color: "#475569", fontSize: 11 }}>
          {new Date(lic.issuedAt).toLocaleTimeString()}
        </span>
      </td>
      <td style={td}>{lic.tier}</td>
      <td style={{ ...td, whiteSpace: "nowrap" }}>
        {new Date(lic.expiresAt).toLocaleDateString()}
      </td>
      <td style={td}>
        <span
          style={{
            display: "inline-block",
            padding: "2px 6px",
            borderRadius: 4,
            fontSize: 10,
            background: `${status.color}20`,
            color: status.color,
            border: `1px solid ${status.color}40`,
          }}
        >
          {status.label}
        </span>
      </td>
      <td style={{ ...td, color: "#94a3b8", fontSize: 11 }}>
        {lic.issuedByEmail}
      </td>
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        <Link
          to={`/licenses/issue?${renewHref}`}
          style={{ color: "#60a5fa", fontSize: 11, marginRight: 12 }}
        >
          Renew
        </Link>
        {canRevoke && !lic.revokedAt && (
          <button
            onClick={() => {
              const reason = prompt(
                "Reason for revocation? (Optional but recorded in the audit log.)",
              );
              if (reason === null) return; // user cancelled
              onRevoke(reason || undefined);
            }}
            disabled={pending}
            style={{
              background: "transparent",
              color: "#fca5a5",
              border: "1px solid #7f1d1d",
              borderRadius: 4,
              padding: "2px 8px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Revoke
          </button>
        )}
      </td>
    </tr>
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
const th: React.CSSProperties = {
  padding: "8px 12px",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const td: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 13,
};
