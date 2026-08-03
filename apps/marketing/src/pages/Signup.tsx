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
 * Two states: the form, and "check your email". Nothing is created
 * here — the workspace is built on /signup/confirm, once the link in
 * that email is clicked. A mistyped address therefore costs an
 * expiring row rather than a live tenant nobody can reach.
 */

interface SignupRequested {
  adminEmail: string;
  expiresAt: string;
}

/** Shape returned by /public/signup/confirm once a tenant exists. */
export interface SignupSuccess {
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
  const [sent, setSent] = useState<SignupRequested | null>(null);

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
      setSent(body as SignupRequested);
    } catch {
      setError("Couldn't reach the server. Check your connection and retry.");
    } finally {
      setBusy(false);
    }
  };

  if (sent) return <CheckYourEmail sent={sent} />;

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
        database, your own members, nobody else&apos;s data in it. Free for 30
        days. We&apos;ll email you a link to confirm, then it&apos;s ready in
        about a minute.
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
          hint="We send the confirmation link here, and this becomes your admin sign-in. Nothing is created until you click it."
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
          {busy ? "Sending…" : "Email me a confirmation link"}
        </button>
      </form>
    </section>
  );
}

/**
 * Terminal state for step 1. Deliberately says nothing about whether
 * the address exists or was already used — the server doesn't tell us,
 * and repeating a guess back would make this a way to probe addresses.
 */
function CheckYourEmail({ sent }: { sent: SignupRequested }) {
  return (
    <section style={{ padding: "64px 24px", ...container, maxWidth: 620 }}>
      <h1 style={{ fontSize: 32, margin: "0 0 12px", letterSpacing: -0.6 }}>
        Check your email
      </h1>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: 15,
          lineHeight: 1.6,
          margin: "0 0 20px",
        }}
      >
        We sent a confirmation link to{" "}
        <strong style={{ color: "var(--text)" }}>{sent.adminEmail}</strong>.
        Click it and your workspace is built — about a minute — and you&apos;ll
        get your sign-in details on the page that follows.
      </p>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: 13,
          lineHeight: 1.6,
          margin: "0 0 8px",
        }}
      >
        The link expires {new Date(sent.expiresAt).toLocaleString()}. Nothing
        has been created yet, so if you mistyped the address just{" "}
        <Link to="/signup">start again</Link> — the unused request expires on
        its own.
      </p>
      <p style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6 }}>
        Nothing arrived? Check spam, then <Link to="/contact">tell us</Link>.
      </p>
    </section>
  );
}

/**
 * Post-provisioning credentials, shown on /signup/confirm. The password
 * is unrecoverable once this page is gone, so it gets the loudest
 * treatment on the site and the sign-in link sits below it rather than
 * above — clicking through before copying is the mistake worth
 * designing against.
 */
export function Credentials({ result }: { result: SignupSuccess }) {
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
