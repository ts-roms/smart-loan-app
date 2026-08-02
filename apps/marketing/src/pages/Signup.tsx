import { useState, type CSSProperties, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { appUrl, btnPrimary, container, inputStyle } from "../App";

/**
 * Hosted signup — provisions a cooperative's workspace with no vendor
 * in the loop.
 *
 * The site's whole pitch is on-prem ownership, so this page doesn't
 * pretend hosted is the better choice; it says plainly what you give
 * up and points at /install for the alternative. Someone who wants to
 * evaluate without standing up a server should be able to, in one
 * form, without waiting on a sales reply.
 *
 * Two states: the form, and the credentials panel. That panel is the
 * only time the bootstrap password is ever shown — the server hashes
 * it and can't reproduce it — so it's deliberately hard to click past.
 */

interface SignupSuccess {
  slug: string;
  name: string;
  adminEmail: string;
  bootstrapPassword: string | null;
  licensed: boolean;
}

/** Derive a URL-safe workspace name from what they typed. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function Signup() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // Once they edit the slug by hand we stop overwriting it from the
  // name — otherwise typing the co-op name would silently undo it.
  const [slugTouched, setSlugTouched] = useState(false);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SignupSuccess | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(name);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/public/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: effectiveSlug,
          name: name.trim(),
          adminName: adminName.trim(),
          adminEmail: adminEmail.trim(),
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          body && typeof body === "object" && "message" in body
            ? String(body.message)
            : "Something went wrong. Please try again.";
        setError(message);
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

  return (
    <section style={{ padding: "64px 24px", ...container, maxWidth: 620 }}>
      <h1 style={{ fontSize: 34, margin: "0 0 12px", letterSpacing: -0.6 }}>
        Start a hosted trial
      </h1>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: 15,
          lineHeight: 1.6,
          margin: "0 0 8px",
        }}
      >
        We&apos;ll set up a private workspace for your cooperative — your own
        database, your own members, nobody else&apos;s data in it. Ready in
        about a minute, free for 30 days.
      </p>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: 13,
          lineHeight: 1.6,
          margin: "0 0 32px",
        }}
      >
        Prefer to keep everything on your own hardware? That&apos;s the option
        we&apos;d normally recommend —{" "}
        <Link to="/install">install it on your server</Link> instead.
      </p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 18 }}>
        <Field
          label="Cooperative name"
          hint="Shown to your members and on documents."
        >
          <input
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bayanihan Multi-Purpose Cooperative"
            required
          />
        </Field>

        <Field
          label="Workspace name"
          hint={
            effectiveSlug
              ? `Your members will sign in at ${appUrl}/login?tenant=${effectiveSlug}`
              : "Lowercase letters, numbers and dashes. This can't be changed later."
          }
        >
          <input
            style={inputStyle}
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
            placeholder="bayanihan-mpc"
            pattern="[a-z][a-z0-9-]+"
            minLength={2}
            maxLength={40}
            required
          />
        </Field>

        <Field label="Your name">
          <input
            style={inputStyle}
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            placeholder="Maria Santos"
            required
          />
        </Field>

        <Field
          label="Your email"
          hint="Your admin password is shown once on the next screen — this address is how we reach you afterwards."
        >
          <input
            style={inputStyle}
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="maria@bayanihan-mpc.ph"
            required
          />
        </Field>

        {error && (
          <div
            style={{
              background: "rgba(248,113,113,0.08)",
              border: "1px solid rgba(248,113,113,0.35)",
              color: "#fca5a5",
              borderRadius: 8,
              padding: "12px 14px",
              fontSize: 14,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            ...btnPrimary,
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Setting up your workspace…" : "Create my workspace"}
        </button>
        {busy && (
          <p
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              margin: 0,
              textAlign: "center",
            }}
          >
            This takes up to a minute — we&apos;re building your database.
            Don&apos;t close this tab.
          </p>
        )}
      </form>
    </section>
  );
}

/**
 * Post-signup credentials. The password is unrecoverable once this
 * page is gone, so it gets the loudest treatment on the site and the
 * sign-in link sits below it rather than above — clicking through
 * before copying is the mistake worth designing against.
 */
function Credentials({ result }: { result: SignupSuccess }) {
  const [copied, setCopied] = useState(false);
  const loginUrl = `${appUrl}/login?tenant=${result.slug}`;

  return (
    <section style={{ padding: "64px 24px", ...container, maxWidth: 620 }}>
      <h1 style={{ fontSize: 32, margin: "0 0 12px", letterSpacing: -0.6 }}>
        {result.name} is ready
      </h1>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: 15,
          lineHeight: 1.6,
          margin: "0 0 28px",
        }}
      >
        Your workspace is provisioned. Save these credentials before you go
        anywhere — the password is not stored anywhere we can read it back.
      </p>

      <div
        style={{
          background: "rgba(251,191,36,0.07)",
          border: "1px solid rgba(251,191,36,0.4)",
          borderRadius: 10,
          padding: 20,
          marginBottom: 24,
        }}
      >
        <div
          style={{
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "#fbbf24",
            marginBottom: 14,
          }}
        >
          Shown once — copy it now
        </div>
        <Row label="Sign in at" value={loginUrl} />
        <Row label="Email" value={result.adminEmail} />
        <Row
          label="Password"
          value={result.bootstrapPassword ?? "(set during provisioning)"}
          mono
        />
        {result.bootstrapPassword && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(
                  `${loginUrl}\n${result.adminEmail}\n${result.bootstrapPassword}`,
                )
                .then(() => setCopied(true));
            }}
            style={{
              ...btnPrimary,
              padding: "8px 16px",
              fontSize: 13,
              marginTop: 8,
            }}
          >
            {copied ? "Copied ✓" : "Copy all"}
          </button>
        )}
      </div>

      {!result.licensed && (
        <p
          style={{
            fontSize: 13,
            color: "var(--text-muted)",
            lineHeight: 1.6,
            marginBottom: 24,
          }}
        >
          Note: your trial licence hasn&apos;t been issued yet, so some features
          will be locked until we activate it. We&apos;ve been notified and will
          sort it out — <Link to="/contact">get in touch</Link> if it&apos;s
          urgent.
        </p>
      )}

      <a href={loginUrl} style={btnPrimary}>
        Sign in to {result.slug} →
      </a>

      <p
        style={{
          fontSize: 13,
          color: "var(--text-muted)",
          marginTop: 28,
          lineHeight: 1.6,
        }}
      >
        Change your password from the profile menu once you&apos;re in. Invite
        your officers from Settings → Users.
      </p>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 3 }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 14,
          color: "var(--text)",
          fontFamily: mono ? "ui-monospace, monospace" : "inherit",
          wordBreak: "break-all",
        }}
      >
        {value}
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
  const labelStyle: CSSProperties = {
    fontSize: 14,
    color: "var(--text)",
    marginBottom: 6,
    display: "block",
  };
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {children}
      {hint && (
        <span
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 6,
            display: "block",
            lineHeight: 1.5,
          }}
        >
          {hint}
        </span>
      )}
    </label>
  );
}
