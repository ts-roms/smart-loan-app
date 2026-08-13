import Link from "next/link";

import { appUrl } from "@/lib/site";

/**
 * Home page — SERVER COMPONENT, top to bottom. Zero client JavaScript
 * from this file or anything it renders.
 *
 * This is the migration's cleanest win and also the least interesting
 * one: the page was already pure presentation over hardcoded arrays.
 * It shipped as ~9 KB of React in the Vite bundle for the sole purpose
 * of producing markup that never changes. Here it produces the markup
 * at build time and ships none of it.
 *
 * Section flow is unchanged from apps/marketing/src/pages/Home.tsx:
 *   1. Hero — the cooperative-ownership promise + dual CTA
 *   2. Differentiators — three signature pillars
 *   3. Feature snapshot — what's actually inside
 *   4. Deployment models — on-prem vs hosted
 *   5. Final CTA
 */
export default function HomePage() {
  return (
    <div>
      <Hero />
      <Differentiators />
      <FeatureSnapshot />
      <DeploymentModels />
      <FinalCTA />
    </div>
  );
}

function Hero() {
  return (
    <section className="border-b border-border bg-[linear-gradient(180deg,var(--bg-elev)_0%,var(--bg)_100%)] px-6 pb-20 pt-[100px] text-center">
      <div className="mx-auto max-w-[800px] px-6 py-6">
        <div className="mb-6 inline-block rounded-full border border-accent-ring bg-accent-soft px-3 py-1 text-xs tracking-[0.3px] text-accent">
          BUILT FOR PHILIPPINE COOPERATIVES
        </div>
        <h1 className="m-0 mb-6 text-[52px] font-bold leading-[1.1] tracking-[-1px]">
          Loan management software{" "}
          <span className="text-accent">your cooperative owns</span>
        </h1>
        <p className="m-0 mb-9 text-[19px] leading-[1.5] text-fg-dim">
          Install SmartLoan on your own server with a perpetual license. Your
          data stays on your hardware. No recurring SaaS fees, no phone-home, no
          vendor lock-in. Hosted option available when you&apos;d rather not run
          servers yourself.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/install" className="btn-primary">
            Install on your server →
          </Link>
          {/*
            Secondary on purpose. The hosted trial is now self-serve
            rather than a sales conversation, so it earns a real button
            — but the page's argument is on-prem ownership, and making
            them equals would undercut it.
          */}
          <Link href="/signup" className="btn-secondary">
            Try it hosted, free
          </Link>
        </div>
        <p className="mt-6 text-[13px] text-fg-muted">
          30-day trial, no card. Or <Link href="/pricing">see pricing</Link>.
        </p>
      </div>
    </section>
  );
}

const PILLARS = [
  {
    title: "Your data, your hardware",
    body: "Perpetual on-prem license. SmartLoan runs entirely inside your own infrastructure — Postgres on your server, files on your disk. Compliance audits stop at your firewall.",
  },
  {
    title: "Works offline, signed licenses",
    body: "License tokens are Ed25519-signed and verify locally. Once activated, the software keeps running with no network connection to the vendor. Renewals happen on your schedule.",
  },
  {
    title: "Built for cooperative reality",
    body: "DORSI compliance, BSP-aligned reporting, member contributions and savings, lease-to-own, repossession workflows. Not a generic LMS bolted to a cooperative module.",
  },
];

function Differentiators() {
  return (
    <section className="mx-auto max-w-shell px-6 py-20">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-6">
        {PILLARS.map((p) => (
          <div
            key={p.title}
            className="rounded-xl border border-border bg-bg-elev p-7"
          >
            <h3 className="m-0 mb-3 text-lg text-fg">{p.title}</h3>
            <p className="m-0 text-sm leading-relaxed text-fg-dim">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const CATEGORIES: Array<{ title: string; items: string[] }> = [
  {
    title: "Core lending",
    items: [
      "Customer + KYC + credit scoring",
      "Loan products with configurable terms",
      "Disbursement + payment schedules",
      "Co-makers + collateral (vehicle / property)",
    ],
  },
  {
    title: "Servicing",
    items: [
      "Collections queue + promise-to-pay",
      "Demand letters with escalation matrix",
      "Repossession workflow",
      "Lease-to-own product",
    ],
  },
  {
    title: "Accounting",
    items: [
      "Double-entry GL with auto-posting",
      "Period close + reopen",
      "Bank reconciliation",
      "IFRS-9 ECL provisioning (ENTERPRISE)",
    ],
  },
  {
    title: "Cooperative module",
    items: [
      "Member contributions + share capital",
      "Savings + withdrawals",
      "Fund management",
      "Patronage refund tracking",
    ],
  },
  {
    title: "Compliance",
    items: [
      "DORSI screening at onboarding",
      "Annual document tracking",
      "BSP-aligned compliance reports",
      "Full audit log",
    ],
  },
  {
    title: "Intelligence (ENTERPRISE)",
    items: [
      "In-browser ID OCR",
      "Selfie ↔ ID face match",
      "Anomaly + risk flagger",
      "Local LLM assistant (Ollama)",
    ],
  },
];

function FeatureSnapshot() {
  return (
    <section className="border-y border-border bg-bg-elev px-6 py-20">
      <div className="mx-auto max-w-shell px-6 py-6">
        <div className="mb-12 text-center">
          <h2 className="m-0 mb-3 text-[32px] tracking-[-0.5px]">
            What&apos;s inside
          </h2>
          <p className="mx-auto max-w-[560px] text-base text-fg-dim">
            Six functional areas, configured by tier. Every cooperative
            installation gets the same codebase — your license unlocks the
            modules you&apos;ve paid for.
          </p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-5">
          {CATEGORIES.map((cat) => (
            <div
              key={cat.title}
              className="rounded-[10px] border border-border bg-bg p-5"
            >
              <h3 className="m-0 mb-3 text-sm uppercase tracking-[0.5px] text-accent">
                {cat.title}
              </h3>
              <ul className="m-0 list-none p-0 text-[13px] leading-[1.8] text-fg-dim">
                {cat.items.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DeploymentModels() {
  return (
    <section className="mx-auto max-w-shell px-6 py-20">
      <div className="mb-12 text-center">
        <h2 className="m-0 mb-3 text-[32px] tracking-[-0.5px]">
          Two ways to deploy
        </h2>
        <p className="mx-auto max-w-[560px] text-base text-fg-dim">
          Same software, same features. Different operational footprint.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-6">
        <DeployCard
          recommended
          title="On-premises"
          subtitle="The default — your hardware, your data"
          points={[
            "One-time perpetual license fee per tier",
            "Runs on a single Linux server + PostgreSQL",
            "Updates installed on your schedule",
            "License renews annually for ongoing support + updates",
            "Optional: hire us for installation, training, integrations",
          ]}
          cta={{ label: "View install guide →", to: "/install" }}
        />
        <DeployCard
          title="Hosted (SaaS)"
          subtitle="When you'd rather not run servers"
          points={[
            "Monthly per-seat subscription",
            "We run the infrastructure on your behalf",
            "Automatic updates + backups",
            "Tenant isolation via dedicated Postgres schema",
            "Export your data at any time — no lock-in",
            "Sign up yourself — workspace ready in a minute",
          ]}
          cta={{ label: "Start a free trial →", to: "/signup" }}
        />
      </div>
    </section>
  );
}

function DeployCard({
  title,
  subtitle,
  points,
  cta,
  recommended,
}: {
  title: string;
  subtitle: string;
  points: string[];
  cta: { label: string; to: string };
  recommended?: boolean;
}) {
  return (
    <div
      className={`relative rounded-xl border bg-bg-elev p-8 ${
        recommended ? "border-accent" : "border-border"
      }`}
    >
      {recommended && (
        <div className="absolute -top-[10px] left-6 rounded bg-accent-strong px-[10px] py-[3px] text-[11px] font-semibold tracking-[0.3px] text-white">
          RECOMMENDED
        </div>
      )}
      <h3 className="m-0 mb-1 text-[22px]">{title}</h3>
      <p className="m-0 mb-6 text-sm text-fg-dim">{subtitle}</p>
      <ul className="m-0 mb-6 list-none p-0 text-sm leading-[1.9] text-fg">
        {points.map((p) => (
          <li key={p} className="relative pl-6">
            <span className="absolute left-0 text-success">✓</span>
            {p}
          </li>
        ))}
      </ul>
      <Link href={cta.to} className="text-sm text-accent">
        {cta.label}
      </Link>
    </div>
  );
}

function FinalCTA() {
  return (
    <section className="border-t border-border bg-bg-elev px-6 py-20 text-center">
      <div className="mx-auto max-w-[600px] px-6 py-6">
        <h2 className="m-0 mb-4 text-[32px] tracking-[-0.5px]">
          Ready to take a look?
        </h2>
        <p className="mb-8 text-base text-fg-dim">
          Spin up a hosted workspace now and have a look around, or tell us
          about your cooperative and we&apos;ll send the install bundle and a
          trial license for your own server.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/signup" className="btn-primary">
            Start a free trial
          </Link>
          <Link href="/contact" className="btn-secondary">
            Request the install bundle
          </Link>
        </div>
        <p className="mt-6 text-[13px] text-fg-muted">
          Already a member of a cooperative that uses SmartLoan?{" "}
          <a href={`${appUrl}/register`}>Create your member account</a>.
        </p>
      </div>
    </section>
  );
}
