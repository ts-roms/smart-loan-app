"use client";

import type { FormEvent, ReactNode } from "react";
import { useState } from "react";

/*
 * CLIENT COMPONENT — justified.
 *
 * A controlled form with six fields, a three-way toggle, an in-flight
 * state and an error banner. Every one of those is `useState`.
 *
 * A REAL alternative exists here and was considered: a Server Action.
 * `POST /public/leads` is an anonymous, rate-limited endpoint, so a
 * server action could post to it from the Next server and the whole
 * form would work with JavaScript disabled. It was NOT done, for two
 * reasons worth recording:
 *
 *   1. It moves the request's origin from the visitor's browser to the
 *      marketing server. The API rate-limits /public/leads by IP; every
 *      submission would then arrive from ONE ip and the limiter would
 *      throttle the site as a whole rather than an abusive visitor.
 *      That is a server-side change, and apps/api is out of scope for
 *      this pilot.
 *
 *   2. It would make this page's behaviour diverge from the Vite app it
 *      is being compared against, which is the opposite of what a
 *      migration pilot is for.
 *
 * Point 1 generalises and is the more important half: an RSC migration
 * silently relocates the client of every API call it converts. Anything
 * the API decides from the caller's identity — rate limits, audit-log
 * IP, geo — changes meaning. For apps/web, where nearly every call is
 * authenticated and audited, that is a much larger question than it is
 * here.
 */

type DeploymentInterest = "ONPREM" | "HOSTED" | "BOTH";

interface LeadForm {
  name: string;
  email: string;
  cooperative: string;
  memberCount: string;
  deploymentInterest: DeploymentInterest;
  message: string;
}

const EMPTY: LeadForm = {
  name: "",
  email: "",
  cooperative: "",
  memberCount: "",
  deploymentInterest: "ONPREM",
  message: "",
};

export function LeadForm() {
  const [form, setForm] = useState<LeadForm>(EMPTY);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "success" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/public/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          memberCount: form.memberCount ? Number(form.memberCount) : undefined,
        }),
      });
      if (!res.ok) {
        // `res.json()` is typed `any`; narrow before reading `.message`
        // so a non-object error body can't produce `undefined` here.
        const body: unknown = await res.json().catch(() => ({}));
        const message =
          typeof body === "object" && body !== null && "message" in body
            ? String(body.message)
            : null;
        throw new Error(
          message ?? `Submission failed (${res.status}). Try again later.`,
        );
      }
      setState({ kind: "success" });
      setForm(EMPTY);
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  };

  if (state.kind === "success") {
    return (
      <div className="rounded-xl border border-success-ring bg-success-soft p-10">
        <h1 className="m-0 mb-3 text-[28px] text-success">
          Got it — we&apos;ll be in touch
        </h1>
        <p className="m-0 text-[15px] leading-relaxed text-fg-dim">
          We&apos;ll email you within 2 business days with next steps. For
          urgent questions, reply to that email — it&apos;s the fastest way to
          get a real person.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field label="Your name" required>
        <input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
          className="field-input"
          autoComplete="name"
        />
      </Field>

      <Field label="Email" required>
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          required
          className="field-input"
          autoComplete="email"
        />
      </Field>

      <Field label="Cooperative name" required>
        <input
          value={form.cooperative}
          onChange={(e) =>
            setForm((f) => ({ ...f, cooperative: e.target.value }))
          }
          required
          placeholder="e.g. Mt Banahaw MPC"
          className="field-input"
          autoComplete="organization"
        />
      </Field>

      <Field
        label="Approximate member count"
        hint="Helps us recommend the right tier"
      >
        <input
          type="number"
          min={0}
          value={form.memberCount}
          onChange={(e) =>
            setForm((f) => ({ ...f, memberCount: e.target.value }))
          }
          placeholder="e.g. 350"
          className="field-input"
        />
      </Field>

      <Field label="How do you want to run it?" required>
        <div className="grid grid-cols-3 gap-2">
          {(["ONPREM", "HOSTED", "BOTH"] as DeploymentInterest[]).map(
            (kind) => (
              <DeploymentChoice
                key={kind}
                kind={kind}
                active={form.deploymentInterest === kind}
                onClick={() =>
                  setForm((f) => ({ ...f, deploymentInterest: kind }))
                }
              />
            ),
          )}
        </div>
      </Field>

      <Field label="Anything else we should know?">
        <textarea
          value={form.message}
          onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))}
          rows={4}
          className="field-input resize-y"
          placeholder="Existing systems we'd be replacing, integrations you need, timelines, …"
        />
      </Field>

      {state.kind === "error" && (
        <div className="rounded-md border border-danger-ring bg-danger-soft p-3 text-[13px] text-danger">
          {state.message}
        </div>
      )}

      <button
        type="submit"
        disabled={state.kind === "submitting"}
        className="btn-primary w-full cursor-pointer"
      >
        {state.kind === "submitting" ? "Sending…" : "Send"}
      </button>
      <p className="mb-0 mt-2 text-center text-xs text-fg-muted">
        We&apos;ll never share your information. Replies come from a real human,
        not an autoresponder.
      </p>
    </form>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex justify-between">
        <span className="text-[13px] text-fg">
          {label}
          {required && <span className="ml-1 text-warning">*</span>}
        </span>
        {hint && <span className="text-xs text-fg-muted">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

const CHOICE_LABELS: Record<
  DeploymentInterest,
  { title: string; sub: string }
> = {
  ONPREM: { title: "On-prem", sub: "We run it" },
  HOSTED: { title: "Hosted", sub: "You run it" },
  BOTH: { title: "Not sure", sub: "Tell us both" },
};

function DeploymentChoice({
  kind,
  active,
  onClick,
}: {
  kind: DeploymentInterest;
  active: boolean;
  onClick: () => void;
}) {
  const { title, sub } = CHOICE_LABELS[kind];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-md border p-3 text-center text-fg transition-colors ${
        active ? "border-accent bg-accent-soft" : "border-border bg-bg"
      }`}
    >
      <div className="text-[13px] font-medium">{title}</div>
      <div className="mt-0.5 text-[11px] text-fg-dim">{sub}</div>
    </button>
  );
}
