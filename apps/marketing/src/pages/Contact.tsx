import { useState } from "react";

import { btnPrimary, container, inputStyle } from "../App";

/**
 * Lead capture page. Posts to POST /public/leads (anonymous endpoint,
 * tightly rate-limited on the API side).
 *
 * The form deliberately collects deploymentInterest as a hard choice
 * so sales knows which path to follow up on first — on-prem and
 * hosted are very different conversations.
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

export function Contact() {
  const [form, setForm] = useState<LeadForm>(EMPTY);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "success" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const submit = async (e: React.FormEvent) => {
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
      <div
        style={{
          ...container,
          maxWidth: 560,
          padding: "80px 24px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            padding: 40,
            background: "var(--success-soft)",
            border: "1px solid var(--success-ring)",
            borderRadius: 12,
          }}
        >
          <h1
            style={{
              fontSize: 28,
              margin: "0 0 12px",
              color: "var(--success)",
            }}
          >
            Got it — we'll be in touch
          </h1>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: 15,
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            We'll email you within 2 business days with next steps. For urgent
            questions, reply to that email — it's the fastest way to get a real
            person.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        ...container,
        maxWidth: 640,
        padding: "60px 24px",
      }}
    >
      <h1
        style={{
          fontSize: 36,
          margin: "0 0 8px",
          letterSpacing: -0.6,
          textAlign: "center",
        }}
      >
        Get in touch
      </h1>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: 15,
          textAlign: "center",
          margin: "0 0 40px",
        }}
      >
        Tell us about your cooperative. We'll send the install bundle and a
        trial license, or set up a hosted instance if that's a better fit.
      </p>

      <form
        onSubmit={submit}
        style={{ display: "flex", flexDirection: "column", gap: 16 }}
      >
        <Field label="Your name" required>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            required
            style={inputStyle}
            autoComplete="name"
          />
        </Field>

        <Field label="Email" required>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            required
            style={inputStyle}
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
            style={inputStyle}
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
            style={inputStyle}
          />
        </Field>

        <Field label="How do you want to run it?" required>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 8,
            }}
          >
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
            onChange={(e) =>
              setForm((f) => ({ ...f, message: e.target.value }))
            }
            rows={4}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            placeholder="Existing systems we'd be replacing, integrations you need, timelines, …"
          />
        </Field>

        {state.kind === "error" && (
          <div
            style={{
              padding: 12,
              background: "var(--danger-soft)",
              border: "1px solid var(--danger-ring)",
              borderRadius: 6,
              fontSize: 13,
              color: "var(--danger)",
            }}
          >
            {state.message}
          </div>
        )}

        <button
          type="submit"
          disabled={state.kind === "submitting"}
          style={{ ...btnPrimary, width: "100%", cursor: "pointer" }}
        >
          {state.kind === "submitting" ? "Sending…" : "Send"}
        </button>
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            textAlign: "center",
            margin: "8px 0 0",
          }}
        >
          We'll never share your information. Replies come from a real human,
          not an autoresponder.
        </p>
      </form>
    </div>
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
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 13, color: "var(--text)" }}>
          {label}
          {required && (
            <span style={{ color: "var(--warning)", marginLeft: 4 }}>*</span>
          )}
        </span>
        {hint && (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </label>
  );
}

function DeploymentChoice({
  kind,
  active,
  onClick,
}: {
  kind: DeploymentInterest;
  active: boolean;
  onClick: () => void;
}) {
  const labels: Record<DeploymentInterest, { title: string; sub: string }> = {
    ONPREM: { title: "On-prem", sub: "We run it" },
    HOSTED: { title: "Hosted", sub: "You run it" },
    BOTH: { title: "Not sure", sub: "Tell us both" },
  };
  const { title, sub } = labels[kind];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: 12,
        background: active ? "var(--accent-soft)" : "var(--bg)",
        border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: 6,
        cursor: "pointer",
        textAlign: "center",
        color: "var(--text)",
        transition: "border-color 0.15s",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginTop: 2,
        }}
      >
        {sub}
      </div>
    </button>
  );
}
