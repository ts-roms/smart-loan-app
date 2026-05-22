import { Link } from "react-router-dom";

import { btnPrimary, btnSecondary, container } from "../App";

/**
 * Home page — single-scroll layout, on-prem-first messaging.
 *
 * Section flow:
 *   1. Hero — the cooperative-ownership promise + dual CTA
 *   2. Differentiators — three signature pillars
 *   3. Feature snapshot — what's actually inside
 *   4. Deployment models — table comparing on-prem vs hosted
 *   5. Final CTA
 */
export function Home() {
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
    <section
      style={{
        padding: "100px 24px 80px",
        textAlign: "center",
        background:
          "linear-gradient(180deg, var(--bg-elev) 0%, var(--bg) 100%)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ ...container, maxWidth: 800 }}>
        <div
          style={{
            display: "inline-block",
            padding: "4px 12px",
            background: "rgba(96,165,250,0.1)",
            border: "1px solid rgba(96,165,250,0.3)",
            borderRadius: 999,
            fontSize: 12,
            color: "var(--accent)",
            marginBottom: 24,
            letterSpacing: 0.3,
          }}
        >
          BUILT FOR PHILIPPINE COOPERATIVES
        </div>
        <h1
          style={{
            fontSize: 52,
            lineHeight: 1.1,
            margin: "0 0 24px",
            letterSpacing: -1,
            fontWeight: 700,
          }}
        >
          Loan management software{" "}
          <span style={{ color: "var(--accent)" }}>your cooperative owns</span>
        </h1>
        <p
          style={{
            fontSize: 19,
            color: "var(--text-dim)",
            margin: "0 0 36px",
            lineHeight: 1.5,
          }}
        >
          Install SmartLoan on your own server with a perpetual license. Your
          data stays on your hardware. No recurring SaaS fees, no phone-home, no
          vendor lock-in. Hosted option available when you'd rather not run
          servers yourself.
        </p>
        <div
          style={{
            display: "flex",
            gap: 12,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <Link to="/install" style={btnPrimary}>
            Install on your server →
          </Link>
          <Link to="/pricing" style={btnSecondary}>
            See pricing
          </Link>
        </div>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 24 }}>
          Or <Link to="/contact">talk to us</Link> about a hosted trial.
        </p>
      </div>
    </section>
  );
}

function Differentiators() {
  const pillars = [
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
  return (
    <section style={{ padding: "80px 24px", ...container }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 24,
        }}
      >
        {pillars.map((p) => (
          <div
            key={p.title}
            style={{
              padding: 28,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              borderRadius: 12,
            }}
          >
            <h3
              style={{ fontSize: 18, margin: "0 0 12px", color: "var(--text)" }}
            >
              {p.title}
            </h3>
            <p
              style={{
                color: "var(--text-dim)",
                fontSize: 14,
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              {p.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function FeatureSnapshot() {
  const categories: Array<{ title: string; items: string[] }> = [
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
  return (
    <section
      style={{
        padding: "80px 24px",
        background: "var(--bg-elev)",
        borderTop: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={container}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <h2
            style={{
              fontSize: 32,
              margin: "0 0 12px",
              letterSpacing: -0.5,
            }}
          >
            What's inside
          </h2>
          <p
            style={{
              color: "var(--text-dim)",
              fontSize: 16,
              maxWidth: 560,
              margin: "0 auto",
            }}
          >
            Six functional areas, configured by tier. Every cooperative
            installation gets the same codebase — your license unlocks the
            modules you've paid for.
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: 20,
          }}
        >
          {categories.map((cat) => (
            <div
              key={cat.title}
              style={{
                padding: 20,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 10,
              }}
            >
              <h3
                style={{
                  fontSize: 14,
                  margin: "0 0 12px",
                  color: "var(--accent)",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {cat.title}
              </h3>
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  fontSize: 13,
                  color: "var(--text-dim)",
                  lineHeight: 1.8,
                }}
              >
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
    <section style={{ padding: "80px 24px", ...container }}>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <h2 style={{ fontSize: 32, margin: "0 0 12px", letterSpacing: -0.5 }}>
          Two ways to deploy
        </h2>
        <p
          style={{
            color: "var(--text-dim)",
            fontSize: 16,
            maxWidth: 560,
            margin: "0 auto",
          }}
        >
          Same software, same features. Different operational footprint.
        </p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 24,
        }}
      >
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
          ]}
          cta={{ label: "Talk to sales →", to: "/contact" }}
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
      style={{
        padding: 32,
        background: "var(--bg-elev)",
        border: recommended
          ? "1px solid var(--accent)"
          : "1px solid var(--border)",
        borderRadius: 12,
        position: "relative",
      }}
    >
      {recommended && (
        <div
          style={{
            position: "absolute",
            top: -10,
            left: 24,
            background: "var(--accent-strong)",
            color: "white",
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 4,
            fontWeight: 600,
            letterSpacing: 0.3,
          }}
        >
          RECOMMENDED
        </div>
      )}
      <h3 style={{ fontSize: 22, margin: "0 0 4px" }}>{title}</h3>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: 14,
          margin: "0 0 24px",
        }}
      >
        {subtitle}
      </p>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 24px",
          color: "var(--text)",
          fontSize: 14,
          lineHeight: 1.9,
        }}
      >
        {points.map((p) => (
          <li key={p} style={{ paddingLeft: 24, position: "relative" }}>
            <span
              style={{
                position: "absolute",
                left: 0,
                color: "var(--success)",
              }}
            >
              ✓
            </span>
            {p}
          </li>
        ))}
      </ul>
      <Link to={cta.to} style={{ color: "var(--accent)", fontSize: 14 }}>
        {cta.label}
      </Link>
    </div>
  );
}

function FinalCTA() {
  return (
    <section
      style={{
        padding: "80px 24px",
        textAlign: "center",
        background: "var(--bg-elev)",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div style={{ ...container, maxWidth: 600 }}>
        <h2 style={{ fontSize: 32, margin: "0 0 16px", letterSpacing: -0.5 }}>
          Ready to take a look?
        </h2>
        <p
          style={{
            color: "var(--text-dim)",
            fontSize: 16,
            marginBottom: 32,
          }}
        >
          Tell us about your cooperative and we'll send you the install bundle +
          a trial license. Or jump straight into pricing.
        </p>
        <div
          style={{
            display: "flex",
            gap: 12,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          <Link to="/contact" style={btnPrimary}>
            Request a trial license
          </Link>
          <Link to="/pricing" style={btnSecondary}>
            See pricing
          </Link>
        </div>
      </div>
    </section>
  );
}
