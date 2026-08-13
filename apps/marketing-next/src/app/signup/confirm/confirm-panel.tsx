"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";

import { Credentials, type SignupSuccess } from "../credentials";

/*
 * CLIENT COMPONENT — justified twice over: `useState` for the in-flight
 * and result states, and `useSearchParams` for the token.
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
 *
 * ── The `useSearchParams` trap, recorded for apps/web ──
 *
 * Calling `useSearchParams()` in a component that is statically
 * rendered fails `next build` outright:
 *
 *   Error: useSearchParams() should be wrapped in a suspense boundary
 *   at page "/signup/confirm".
 *
 * It builds and runs fine in `next dev`, so the failure arrives at the
 * END of the loop rather than the start. The fix is the <Suspense> in
 * ../confirm/page.tsx.
 *
 * There are two ways out and they are not equivalent:
 *
 *   A. Wrap in <Suspense>. The route stays statically prerendered; the
 *      search params are read in the browser after hydration. This is
 *      what the SPA did, and it is what is done here.
 *   B. Read `searchParams` from the Server Component page's props. This
 *      opts the whole route into dynamic (per-request) rendering.
 *
 * apps/web reads query strings on a great many screens — every filtered
 * list, every paginated table. Whoever migrates it will hit this on
 * roughly every one of them, and choosing B by reflex would turn a
 * static app into a server-rendered one page by page without anyone
 * deciding to.
 */
export function ConfirmPanel() {
  const params = useSearchParams();
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
        <p className={TEXT}>
          The confirmation link is missing its token — some mail clients cut
          long URLs. Try copying the whole link from the email, or{" "}
          <Link href="/signup">start again</Link>.
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Confirm your workspace">
      <p className={TEXT}>
        You&apos;re one click from a live workspace. This creates your database
        and your admin account — it takes about a minute, so don&apos;t close
        the tab once you start.
      </p>

      {error && (
        <div className="mb-5 rounded-lg border border-danger-ring bg-danger-soft px-3.5 py-3 text-sm text-danger">
          {error}{" "}
          <Link href="/signup" className="text-inherit">
            Start again
          </Link>
          .
        </div>
      )}

      <button
        type="button"
        onClick={() => void confirm()}
        disabled={busy}
        className={`btn-primary ${busy ? "cursor-wait opacity-60" : "cursor-pointer"}`}
      >
        {busy ? "Building your workspace…" : "Create my workspace"}
      </button>

      {busy && (
        <p className={`${TEXT} mt-5`}>
          Setting up your database and running migrations. This is the slow
          part.
        </p>
      )}
    </Shell>
  );
}

const TEXT = "m-0 mb-6 text-[15px] leading-relaxed text-fg-dim";

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1 className="m-0 mb-3 text-[32px] tracking-[-0.6px]">{title}</h1>
      {children}
    </>
  );
}
