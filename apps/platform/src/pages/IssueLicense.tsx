import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { btnPrimary, inputStyle } from "../App";
import { makeApi, useAuth } from "../AuthProvider";

/**
 * License issuance form. Replaces the `pnpm --filter @loan/licensing issue`
 * CLI for production. Calls the platform API which signs with the
 * private key on the platform host.
 */
export function IssueLicense() {
  const { token } = useAuth();
  const api = makeApi(token);
  const [params] = useSearchParams();
  // Renew flow deep-links here with `tenant`, `tenantName`, `tier`,
  // `seats`, and `notes` prefilled from a previous license. Expiry is
  // intentionally NOT carried over — the whole point of renewal is a
  // fresh one — so it defaults to one year out.
  const [tenantSlug, setTenantSlug] = useState(params.get("tenant") ?? "");
  const [tenantName, setTenantName] = useState(params.get("tenantName") ?? "");
  const initialTier = params.get("tier");
  const [tier, setTier] = useState<"BASIC" | "PROFESSIONAL" | "ENTERPRISE">(
    initialTier === "BASIC" ||
      initialTier === "PROFESSIONAL" ||
      initialTier === "ENTERPRISE"
      ? initialTier
      : "PROFESSIONAL",
  );
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [seats, setSeats] = useState(params.get("seats") ?? "");
  const [notes, setNotes] = useState(params.get("notes") ?? "");

  const [issued, setIssued] = useState<{
    token: string;
    payload: unknown;
  } | null>(null);

  const issue = useMutation({
    mutationFn: () =>
      api<{ token: string; payload: unknown }>("/platform/licenses", {
        method: "POST",
        body: JSON.stringify({
          tenantSlug,
          tenantName: tenantName.trim() || undefined,
          tier,
          expiresAt: new Date(expiresAt).toISOString(),
          seats: seats ? Number(seats) : undefined,
          notes: notes.trim() || undefined,
        }),
      }),
    onSuccess: (res) => setIssued(res),
  });

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 22, margin: "0 0 24px" }}>Issue license</h1>

      {!issued ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            issue.mutate();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <Row>
            <Field label="Tenant slug">
              <input
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value)}
                placeholder="mt-banahaw-mpc"
                style={inputStyle}
                required
              />
            </Field>
            <Field label="Tenant display name (optional)">
              <input
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                placeholder="Mt Banahaw MPC"
                style={inputStyle}
              />
            </Field>
          </Row>

          <Row>
            <Field label="Tier">
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as typeof tier)}
                style={inputStyle}
              >
                <option value="BASIC">BASIC</option>
                <option value="PROFESSIONAL">PROFESSIONAL</option>
                <option value="ENTERPRISE">ENTERPRISE</option>
              </select>
            </Field>
            <Field label="Expires at">
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                style={inputStyle}
                required
              />
            </Field>
          </Row>

          <Row>
            <Field label="Seats (0 = unlimited, blank = tier default)">
              <input
                type="number"
                min={0}
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
                placeholder="(tier default)"
                style={inputStyle}
              />
            </Field>
          </Row>

          <Field label="Notes (shown in the tenant's /settings/license)">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Year-1 renewal, paid via wire 2026-05-22"
              style={inputStyle}
            />
          </Field>

          {issue.error && (
            <div
              style={{
                padding: 12,
                background: "var(--danger-soft)",
                border: "1px solid var(--danger-ring)",
                borderRadius: 4,
                fontSize: 13,
                color: "var(--danger)",
              }}
            >
              {issue.error.message}
            </div>
          )}

          <button type="submit" style={btnPrimary} disabled={issue.isPending}>
            {issue.isPending ? "Signing…" : "Issue license"}
          </button>
        </form>
      ) : (
        <IssuedResult result={issued} onIssueAnother={() => setIssued(null)} />
      )}
    </div>
  );
}

function IssuedResult({
  result,
  onIssueAnother,
}: {
  result: { token: string; payload: unknown };
  onIssueAnother: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers / non-HTTPS — let the user copy manually.
    }
  };

  return (
    <div>
      <div
        style={{
          padding: 16,
          background: "var(--success-soft)",
          border: "1px solid var(--success-ring)",
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <strong style={{ color: "var(--success)" }}>License signed.</strong>
        <p
          style={{ fontSize: 13, color: "var(--text-dim)", margin: "4px 0 0" }}
        >
          Send the token below to the tenant admin. They paste it into Settings
          → License on their instance to activate.
        </p>
      </div>

      <label style={{ fontSize: 12, color: "var(--text-dim)" }}>
        License token
      </label>
      <textarea
        readOnly
        value={result.token}
        rows={6}
        style={{
          ...inputStyle,
          fontFamily: "monospace",
          fontSize: 11,
          marginTop: 4,
          marginBottom: 8,
        }}
        onClick={(e) => (e.target as HTMLTextAreaElement).select()}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={copy} style={btnPrimary}>
          {copied ? "Copied!" : "Copy token"}
        </button>
        <button
          onClick={onIssueAnother}
          style={{
            ...btnPrimary,
            background: "transparent",
            border: "1px solid var(--border-strong)",
          }}
        >
          Issue another
        </button>
      </div>

      <details
        style={{ marginTop: 24, fontSize: 12, color: "var(--text-dim)" }}
      >
        <summary style={{ cursor: "pointer" }}>Payload</summary>
        <pre
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: 12,
            fontSize: 11,
            overflowX: "auto",
          }}
        >
          {JSON.stringify(result.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        style={{
          display: "block",
          fontSize: 12,
          color: "var(--text-dim)",
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function defaultExpiry(): string {
  // Default to 1 year from now, at 5pm UTC. datetime-local wants
  // "YYYY-MM-DDTHH:mm" in local time.
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  d.setHours(17, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
