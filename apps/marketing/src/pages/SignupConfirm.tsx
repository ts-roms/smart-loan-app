import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { btnPrimary, container } from "../App";
import { Credentials, type SignupSuccess } from "./Signup";

/**
 * Signup step 2 — where the workspace is actually built.
 *
 * The token arrives in the query string from the confirmation email.
 * Provisioning is NOT triggered on mount, deliberately: mail clients
 * and security scanners prefetch links, and an auto-firing page would
 * let a scanner create a Postgres schema. It takes a click, which also
 * gives somewhere to show what's about to happen.
 *
 * The POST is one-shot. Once redeemed the token is consumed, so a
 * refresh reports "already used" rather than building a second
 * workspace.
 */
export function SignupConfirm() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SignupSuccess | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/public/signup/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          body && typeof body === "object" && "message" in body
            ? String(body.message)
            : "Something went wrong. Please try again.",
        );
        return;
      }
      setDone(body as SignupSuccess);
    } catch {
      setError("Couldn't reach the server. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  };

  if (done) return <Credentials result={done} />;

  if (!token) {
    return (
      <Shell title="That link is incomplete">
        <p style={text}>
          The confirmation link is missing its token — some mail clients cut
          long URLs. Try copying the whole link from the email, or{" "}
          <Link to="/signup">start again</Link>.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Confirm your workspace">
      <p style={text}>
        You&apos;re one click from a live workspace. This creates your database
        and your admin account — it takes about a minute, so don&apos;t close
        the tab once you start.
      </p>

      {error && (
        <div
          style={{
            background: "var(--danger-soft)",
            border: "1px solid var(--danger-ring)",
            color: "var(--danger)",
            borderRadius: 8,
            padding: "12px 14px",
            fontSize: 14,
            margin: "0 0 20px",
          }}
        >
          {error}{" "}
          <Link to="/signup" style={{ color: "inherit" }}>
            Start again
          </Link>
          .
        </div>
      )}

      <button
        type="button"
        onClick={() => void confirm()}
        disabled={busy}
        style={{
          ...btnPrimary,
          opacity: busy ? 0.6 : 1,
          cursor: busy ? "wait" : "pointer",
        }}
      >
        {busy ? "Building your workspace…" : "Create my workspace"}
      </button>

      {busy && (
        <p style={{ ...text, marginTop: 20 }}>
          Setting up your database and running migrations. This is the slow
          part.
        </p>
      )}
    </Shell>
  );
}

const text: React.CSSProperties = {
  color: "var(--text-dim)",
  fontSize: 15,
  lineHeight: 1.6,
  margin: "0 0 24px",
};

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ padding: "64px 24px", ...container, maxWidth: 620 }}>
      <h1 style={{ fontSize: 32, margin: "0 0 12px", letterSpacing: -0.6 }}>
        {title}
      </h1>
      {children}
    </section>
  );
}
