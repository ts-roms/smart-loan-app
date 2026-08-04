import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { btnPrimary, btnSecondary } from "../App";
import { makeApi, useAuth } from "../AuthProvider";

interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  provisioningError?: string | null;
  licenseSnapshot: {
    jti?: string;
    tier?: string;
    exp?: number;
    features?: string[];
    seats?: number;
  } | null;
}

interface RetryProvisioningResponse {
  status: "ACTIVE";
  bootstrapPassword: string | null;
  bootstrapAdminEmail: string;
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
      void qc.invalidateQueries({ queryKey: ["platform", "tenant", slug] });
      void qc.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
  });

  const revoke = useMutation({
    mutationFn: ({ jti, reason }: { jti: string; reason?: string }) =>
      api(`/platform/licenses/${jti}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["platform", "tenant", slug] });
      void qc.invalidateQueries({
        queryKey: ["platform", "tenant", slug, "licenses"],
      });
      void qc.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
  });

  const [retryResult, setRetryResult] =
    useState<RetryProvisioningResponse | null>(null);
  const retry = useMutation({
    mutationFn: () =>
      api<RetryProvisioningResponse>(
        `/platform/tenants/${slug}/retry-provisioning`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    onSuccess: (res) => {
      setRetryResult(res);
      void qc.invalidateQueries({ queryKey: ["platform", "tenant", slug] });
      void qc.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
  });

  if (isLoading) return <p style={{ color: "var(--text-dim)" }}>Loading…</p>;
  if (!data) return <p style={{ color: "var(--danger)" }}>Tenant not found.</p>;

  return (
    <div>
      <Link to="/tenants" style={{ color: "var(--accent)", fontSize: 13 }}>
        ← Tenants
      </Link>
      <h1 style={{ fontSize: 22, margin: "12px 0 4px" }}>{data.name}</h1>
      <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 24 }}>
        <code>{data.slug}</code> · {data.status}
      </div>

      {data.status === "PROVISIONING" && (
        <ProvisioningSection
          tenant={data}
          retryResult={retryResult}
          onRetry={() => retry.mutate()}
          retrying={retry.isPending}
          retryError={retry.error}
          canRetry={isAdmin}
        />
      )}

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
          <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
            No license issued yet for this tenant.
          </p>
        )}
        <Link
          to={`/licenses/issue?tenant=${data.slug}`}
          style={{
            display: "inline-block",
            marginTop: 12,
            color: "var(--accent)",
            fontSize: 13,
          }}
        >
          Issue a license for this tenant →
        </Link>
      </section>

      <section style={card}>
        <h2 style={h2}>License history</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0 }}>
          Every license issued for this tenant. Revoke is platform-side only —
          the signed token still validates on tenant instances until its expiry.
          In practice: revoke, then issue a fresh token with new terms.
        </p>
        {licenses.isLoading && (
          <p style={{ fontSize: 13, color: "var(--text-dim)" }}>Loading…</p>
        )}
        {licenses.data && licenses.data.length === 0 && (
          <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
            No licenses have been issued yet.
          </p>
        )}
        {licenses.data && licenses.data.length > 0 && (
          <div className="pf-tablewrap">
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr
                  style={{
                    textAlign: "left",
                    color: "var(--text-dim)",
                    fontSize: 11,
                  }}
                >
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
                    onRevoke={(reason) =>
                      revoke.mutate({ jti: lic.jti, reason })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {isAdmin && (
        <section style={card}>
          <h2 style={h2}>Lifecycle</h2>
          <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 0 }}>
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
                  borderColor: "var(--danger-ring)",
                  color: "var(--danger)",
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
              style={{ color: "var(--accent)", fontSize: 13 }}
            >
              View audit log for this tenant →
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

function ProvisioningSection({
  tenant,
  retryResult,
  onRetry,
  retrying,
  retryError,
  canRetry,
}: {
  tenant: Tenant;
  retryResult: RetryProvisioningResponse | null;
  onRetry: () => void;
  retrying: boolean;
  retryError: Error | null;
  canRetry: boolean;
}) {
  const failed = Boolean(tenant.provisioningError);
  const bg = failed ? "var(--danger-soft)" : "var(--warning-soft)";
  const border = failed
    ? "1px solid var(--danger-ring)"
    : "1px solid var(--warning-ring)";

  return (
    <section
      style={{
        ...card,
        background: bg,
        border,
      }}
    >
      <h2 style={h2}>
        {failed ? "Provisioning failed" : "Provisioning in progress"}
      </h2>
      {!failed && (
        <p
          style={{ fontSize: 13, color: "var(--text-dim)", margin: "0 0 12px" }}
        >
          The tenant schema is being created and seeded. If you just clicked
          "Provision", this page refreshes automatically every few seconds.
          Expected duration: ~10 seconds.
        </p>
      )}
      {failed && (
        <>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-dim)",
              margin: "0 0 8px",
            }}
          >
            The last provisioning attempt couldn't finish. The recorded error:
          </p>
          <pre
            style={{
              padding: 12,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              fontSize: 12,
              color: "var(--danger)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: "0 0 12px",
            }}
          >
            {tenant.provisioningError}
          </pre>
          <p
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              margin: "0 0 12px",
            }}
          >
            Retry is safe — every step (schema create, migrations, seed) is
            idempotent. If you keep hitting the same error, fix the underlying
            cause first (DATABASE_URL reachable, migrations folder intact, disk
            space) before retrying.
          </p>
        </>
      )}

      {retryResult && <RetrySuccessBanner result={retryResult} />}

      {retryError && (
        <div
          style={{
            padding: 10,
            background: "var(--danger-soft)",
            border: "1px solid var(--danger-ring)",
            borderRadius: 4,
            fontSize: 13,
            color: "var(--danger)",
            marginBottom: 12,
          }}
        >
          {retryError.message}
        </div>
      )}

      {canRetry && failed && !retryResult && (
        <button
          onClick={onRetry}
          disabled={retrying}
          style={{
            ...btnPrimary,
            background: "var(--danger-strong)",
          }}
        >
          {retrying ? "Retrying…" : "Retry provisioning"}
        </button>
      )}
    </section>
  );
}

function RetrySuccessBanner({ result }: { result: RetryProvisioningResponse }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!result.bootstrapPassword) return;
    try {
      await navigator.clipboard.writeText(result.bootstrapPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* manual copy fallback */
    }
  };
  return (
    <div
      style={{
        padding: 16,
        background: "var(--success-soft)",
        border: "1px solid var(--success-ring)",
        borderRadius: 8,
        marginBottom: 12,
      }}
    >
      <strong style={{ color: "var(--success)" }}>
        Provisioning complete.
      </strong>
      <p
        style={{ fontSize: 13, color: "var(--text-dim)", margin: "4px 0 12px" }}
      >
        Status is now ACTIVE. Refresh to see the rest of the tenant page.
      </p>
      {result.bootstrapPassword && (
        <div>
          <div
            style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}
          >
            Admin email
          </div>
          <div
            style={{
              fontSize: 13,
              fontFamily: "monospace",
              marginBottom: 12,
            }}
          >
            {result.bootstrapAdminEmail}
          </div>
          <div
            style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}
          >
            Initial password (shown once)
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <div
              style={{
                flex: 1,
                padding: "8px 12px",
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontSize: 13,
                fontFamily: "monospace",
                color: "var(--warning)",
                userSelect: "all",
              }}
            >
              {result.bootstrapPassword}
            </div>
            <button onClick={copy} style={btnPrimary}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}
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
    ? { label: "REVOKED", color: "var(--danger)" }
    : expired
      ? { label: "EXPIRED", color: "var(--text-muted)" }
      : isCurrent
        ? { label: "ACTIVE", color: "var(--success)" }
        : { label: "SUPERSEDED", color: "var(--text-dim)" };

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
        borderTop: "1px solid var(--border)",
        opacity: lic.revokedAt || expired ? 0.7 : 1,
      }}
    >
      <td style={td}>
        {new Date(lic.issuedAt).toLocaleDateString()}{" "}
        <span style={{ color: "var(--text-faint)", fontSize: 11 }}>
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
      <td style={{ ...td, color: "var(--text-dim)", fontSize: 11 }}>
        {lic.issuedByEmail}
      </td>
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        <Link
          to={`/licenses/issue?${renewHref}`}
          style={{ color: "var(--accent)", fontSize: 11, marginRight: 12 }}
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
              color: "var(--danger)",
              border: "1px solid var(--danger-ring)",
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
      <div style={{ width: 120, color: "var(--text-dim)" }}>{label}</div>
      <div>{value}</div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
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
