"use client";

import Link from "next/link";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

import { appUrl, slugify } from "@/lib/site";

/*
 * CLIENT COMPONENT — justified.
 *
 * Five pieces of state, one of which (`slugTouched`) exists purely to
 * mediate between two other fields as they are typed. That is
 * per-keystroke interaction; there is no server rendering of it.
 *
 * `slugify` was moved to @/lib/site so it can be unit-tested without
 * dragging a client component into the test process — see
 * src/lib/site.test.ts. Under Vite it lived in the page file and was
 * untested.
 */

interface SignupRequested {
  adminEmail: string;
  expiresAt: string;
}

export function SignupForm() {
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
    <>
      <h1 className="m-0 mb-3 text-[34px] tracking-[-0.6px]">
        Start a hosted trial
      </h1>
      <p className="m-0 mb-2 text-[15px] leading-relaxed text-fg-dim">
        We&apos;ll set up a private workspace for your cooperative — your own
        database, your own members, nobody else&apos;s data in it. Free for 30
        days. We&apos;ll email you a link to confirm, then it&apos;s ready in
        about a minute.
      </p>
      <p className="m-0 mb-8 text-[13px] leading-relaxed text-fg-muted">
        Prefer to keep everything on your own hardware? That&apos;s the option
        we&apos;d normally recommend —{" "}
        <Link href="/install">install it on your server</Link> instead.
      </p>

      <form onSubmit={onSubmit} className="grid gap-[18px]">
        <Field
          label="Cooperative name"
          hint="Shown to your members and on documents."
        >
          <input
            className="field-input"
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
            className="field-input"
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
            className="field-input"
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
            className="field-input"
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="maria@bayanihan-mpc.ph"
            required
          />
        </Field>

        {error && (
          <div className="rounded-lg border border-danger-ring bg-danger-soft px-3.5 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className={`btn-primary ${busy ? "cursor-wait opacity-60" : "cursor-pointer"}`}
        >
          {busy ? "Sending…" : "Email me a confirmation link"}
        </button>
      </form>
    </>
  );
}

/**
 * Terminal state for step 1. Deliberately says nothing about whether
 * the address exists or was already used — the server doesn't tell us,
 * and repeating a guess back would make this a way to probe addresses.
 */
function CheckYourEmail({ sent }: { sent: SignupRequested }) {
  return (
    <>
      <h1 className="m-0 mb-3 text-[32px] tracking-[-0.6px]">
        Check your email
      </h1>
      <p className="m-0 mb-5 text-[15px] leading-relaxed text-fg-dim">
        We sent a confirmation link to{" "}
        <strong className="text-fg">{sent.adminEmail}</strong>. Click it and
        your workspace is built — about a minute — and you&apos;ll get your
        sign-in details on the page that follows.
      </p>
      <p className="m-0 mb-2 text-[13px] leading-relaxed text-fg-muted">
        {/*
          `toLocaleString()` with no explicit locale. It runs in the
          browser here because this is a Client Component, so it uses
          the visitor's locale exactly as the Vite app did. Had this
          been rendered on the server it would have used the SERVER's
          locale and timezone and quietly told a Manila visitor the
          wrong expiry time — the same class of hazard as the footer's
          copyright year, but with a consequence.
        */}
        The link expires {new Date(sent.expiresAt).toLocaleString()}. Nothing
        has been created yet, so if you mistyped the address just{" "}
        <Link href="/signup">start again</Link> — the unused request expires on
        its own.
      </p>
      <p className="text-[13px] leading-relaxed text-fg-muted">
        Nothing arrived? Check spam, then <Link href="/contact">tell us</Link>.
      </p>
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label>
      <span className="mb-1.5 block text-sm text-fg">{label}</span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-xs leading-[1.5] text-fg-muted">
          {hint}
        </span>
      )}
    </label>
  );
}
