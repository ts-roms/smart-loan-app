"use client";

import Link from "next/link";
import { useState } from "react";

import { appUrl } from "@/lib/site";

/*
 * CLIENT COMPONENT — justified.
 *
 * `navigator.clipboard.writeText`, plus the "Copied ✓" state that
 * confirms it worked. There is no server equivalent of a clipboard.
 *
 * Shared by /signup/confirm (which renders it after provisioning) —
 * in the Vite app this lived in pages/Signup.tsx and was imported by
 * SignupConfirm.tsx. It is pulled out into its own file here because
 * a `"use client"` file is a bundle boundary, and leaving it in the
 * signup form's module would have dragged the whole signup form into
 * /signup/confirm's client bundle.
 *
 * That is a general rule the migration surfaced: under Vite, where you
 * put a component affects nothing but readability. Under the App
 * Router, module co-location decides what ships. Barrel files are the
 * severe form of this — see the note about @loan/ui in
 * docs/modernization/nextjs-migration.md.
 */

/** Shape returned by /public/signup/confirm once a tenant exists. */
export interface SignupSuccess {
  slug: string;
  name: string;
  adminEmail: string;
  bootstrapPassword: string | null;
  licensed: boolean;
}

/**
 * Post-provisioning credentials. The password is unrecoverable once
 * this page is gone, so it gets the loudest treatment on the site and
 * the sign-in link sits below it rather than above — clicking through
 * before copying is the mistake worth designing against.
 */
export function Credentials({ result }: { result: SignupSuccess }) {
  const [copied, setCopied] = useState(false);
  const loginUrl = `${appUrl}/login?tenant=${result.slug}`;

  return (
    <section className="mx-auto max-w-[620px] px-6 py-16">
      <h1 className="m-0 mb-3 text-[32px] tracking-[-0.6px]">
        {result.name} is ready
      </h1>
      <p className="m-0 mb-7 text-[15px] leading-relaxed text-fg-dim">
        Your workspace is provisioned. Save these credentials before you go
        anywhere — the password is not stored anywhere we can read it back.
      </p>

      <div className="mb-6 rounded-[10px] border border-warning-ring bg-warning-soft p-5">
        <div className="mb-3.5 text-xs uppercase tracking-[0.5px] text-warning">
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
            className="btn-primary mt-2 px-4 py-2 text-[13px]"
          >
            {copied ? "Copied ✓" : "Copy all"}
          </button>
        )}
      </div>

      {!result.licensed && (
        <p className="mb-6 text-[13px] leading-relaxed text-fg-muted">
          Note: your trial licence hasn&apos;t been issued yet, so some features
          will be locked until we activate it. We&apos;ve been notified and will
          sort it out — <Link href="/contact">get in touch</Link> if it&apos;s
          urgent.
        </p>
      )}

      <a href={loginUrl} className="btn-primary">
        Sign in to {result.slug} →
      </a>

      <p className="mt-7 text-[13px] leading-relaxed text-fg-muted">
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
    <div className="mb-3">
      <div className="mb-[3px] text-xs text-fg-muted">{label}</div>
      <div className={`break-all text-sm text-fg ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}
