import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { btnPrimary, btnSecondary, inputStyle } from "../App";
import { makeApi, useAuth } from "../AuthProvider";

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  createdAt: string;
  lastSeenAt: string | null;
  provisioningError?: string | null;
  licenseSnapshot: { tier?: string; exp?: number } | null;
}

interface ProvisionResponse {
  id: string;
  slug: string;
  name: string;
  status: Tenant["status"];
  bootstrapPassword: string | null;
  bootstrapAdminEmail: string | null;
}

export function TenantsList() {
  const { token, user } = useAuth();
  const api = makeApi(token);
  const isAdmin = user?.role === "PLATFORM_ADMIN";
  const [provisionOpen, setProvisionOpen] = useState(false);

  // When any tenant is mid-provisioning, refetch every 3s so the
  // list reflects the transition without the user having to refresh.
  // Once all tenants are settled, fall back to the default cache.
  const { data, isLoading, error } = useQuery({
    queryKey: ["platform", "tenants"],
    queryFn: () => api<Tenant[]>("/platform/tenants"),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((t) => t.status === "PROVISIONING")
        ? 3000
        : false,
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
        <div style={{ display: "flex", gap: 8 }}>
          {isAdmin && (
            <button
              onClick={() => setProvisionOpen(true)}
              style={{
                ...btnPrimary,
                background: "transparent",
                border: "1px solid #334155",
                color: "#cbd5e1",
              }}
            >
              + Provision tenant
            </button>
          )}
          <Link to="/licenses/issue" style={btnPrimary}>
            Issue license
          </Link>
        </div>
      </header>

      {isLoading && <p style={{ color: "#94a3b8" }}>Loading…</p>}
      {error && <p style={{ color: "#fca5a5" }}>Failed: {error.message}</p>}

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
          No tenants yet.{" "}
          {isAdmin && (
            <>
              Click <strong>Provision tenant</strong> to create the first one.
            </>
          )}
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
                  {t.status === "PROVISIONING" && t.provisioningError && (
                    <span
                      title={t.provisioningError}
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        color: "#fca5a5",
                      }}
                    >
                      (error)
                    </span>
                  )}
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

      {provisionOpen && (
        <ProvisionDialog onClose={() => setProvisionOpen(false)} />
      )}
    </div>
  );
}

function ProvisionDialog({ onClose }: { onClose: () => void }) {
  const { token } = useAuth();
  const api = makeApi(token);
  const qc = useQueryClient();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [result, setResult] = useState<ProvisionResponse | null>(null);

  const provision = useMutation({
    mutationFn: () =>
      api<ProvisionResponse>("/platform/tenants", {
        method: "POST",
        body: JSON.stringify({
          slug,
          name,
          adminEmail: adminEmail || undefined,
          adminName: adminName || undefined,
        }),
      }),
    onSuccess: (res) => {
      setResult(res);
      void qc.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
  });

  return (
    <ModalShell
      onClose={onClose}
      title={result ? "Tenant provisioned" : "Provision tenant"}
    >
      {result ? (
        <ProvisionResultView result={result} onClose={onClose} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            provision.mutate();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <p
            style={{
              fontSize: 12,
              color: "#94a3b8",
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            In multi-tenant mode (MULTI_TENANT=true) the API creates a Postgres
            schema, runs all migrations, and seeds canonical content for this
            tenant. Takes ~10s. In single-tenant mode this just creates the
            catalog row.
          </p>

          <Field label="Tenant slug" hint="lowercase, dashes, no spaces">
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="mt-banahaw-mpc"
              pattern="^[a-z][a-z0-9-]+$"
              required
              style={{ ...inputStyle, fontFamily: "monospace" }}
            />
          </Field>

          <Field label="Display name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mt Banahaw MPC"
              required
              style={inputStyle}
            />
          </Field>

          <Field
            label="Bootstrap admin email"
            hint="defaults to admin@<slug>.local — change after sign-in"
          >
            <input
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="(optional)"
              style={inputStyle}
            />
          </Field>

          <Field
            label="Bootstrap admin name"
            hint="defaults to Cooperative Admin"
          >
            <input
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="(optional)"
              style={inputStyle}
            />
          </Field>

          {provision.error && (
            <div
              style={{
                padding: 10,
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 4,
                fontSize: 13,
                color: "#fca5a5",
              }}
            >
              {provision.error.message}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={onClose}
              style={btnSecondary}
              disabled={provision.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={btnPrimary}
              disabled={provision.isPending}
            >
              {provision.isPending ? "Provisioning…" : "Provision"}
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}

function ProvisionResultView({
  result,
  onClose,
}: {
  result: ProvisionResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyPassword = async () => {
    if (!result.bootstrapPassword) return;
    try {
      await navigator.clipboard.writeText(result.bootstrapPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers — operator copies manually.
    }
  };

  // Status comes back as ACTIVE on synchronous success and as
  // PROVISIONING if provisioning failed mid-way.
  const provisioned = result.status === "ACTIVE";

  return (
    <div>
      <div
        style={{
          padding: 16,
          background: provisioned
            ? "rgba(16,185,129,0.1)"
            : "rgba(245,158,11,0.1)",
          border: `1px solid ${provisioned ? "rgba(16,185,129,0.3)" : "rgba(245,158,11,0.3)"}`,
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <strong style={{ color: provisioned ? "#34d399" : "#fbbf24" }}>
          {provisioned ? "Provisioning complete." : "Catalog row created."}
        </strong>
        <p style={{ fontSize: 13, color: "#94a3b8", margin: "4px 0 0" }}>
          {provisioned
            ? "The tenant's schema is ready and seeded. Hand the credentials below to the cooperative's admin."
            : "Multi-tenant mode is off, or provisioning failed. Open the tenant detail page to see the error and retry."}
        </p>
      </div>

      {result.bootstrapPassword && result.bootstrapAdminEmail && (
        <div
          style={{
            padding: 16,
            background: "#0a0f1e",
            border: "1px solid #1e293b",
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "#94a3b8" }}>
              Admin email
            </label>
            <div
              style={{ fontSize: 14, fontFamily: "monospace", marginTop: 4 }}
            >
              {result.bootstrapAdminEmail}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#94a3b8" }}>
              Initial password (shown once)
            </label>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginTop: 4,
              }}
            >
              <div
                style={{
                  flex: 1,
                  fontSize: 14,
                  fontFamily: "monospace",
                  color: "#fbbf24",
                  background: "rgba(245,158,11,0.05)",
                  padding: "8px 12px",
                  borderRadius: 4,
                  border: "1px solid rgba(245,158,11,0.2)",
                  userSelect: "all",
                }}
              >
                {result.bootstrapPassword}
              </div>
              <button onClick={copyPassword} style={btnPrimary}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p
              style={{
                fontSize: 11,
                color: "#fbbf24",
                margin: "8px 0 0",
              }}
            >
              ⚠ Save this now — it's not retrievable later. The cooperative
              admin should change it on first login.
            </p>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Link
          to={`/tenants/${result.slug}`}
          style={btnSecondary}
          onClick={onClose}
        >
          Open tenant
        </Link>
        <button onClick={onClose} style={btnPrimary}>
          Done
        </button>
      </div>
    </div>
  );
}

function ModalShell({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: "90vw",
          background: "#0e1525",
          border: "1px solid #1e293b",
          borderRadius: 8,
          padding: 24,
        }}
      >
        <h2 style={{ fontSize: 18, margin: "0 0 20px" }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <label style={{ fontSize: 12, color: "#94a3b8" }}>{label}</label>
        {hint && <span style={{ fontSize: 11, color: "#64748b" }}>{hint}</span>}
      </div>
      {children}
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
