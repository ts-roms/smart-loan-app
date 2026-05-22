import { Link } from "react-router-dom";

import { btnPrimary, btnSecondary, container } from "../App";

/**
 * On-prem install guide. The marketing pitch promises "install on your
 * own server" — this page shows what that actually looks like.
 *
 * Honest about the prerequisites: Linux + Postgres + Node.js. Not a
 * point-and-click installer (yet), because cooperatives running their
 * own infra typically have an IT contact who's comfortable with this.
 *
 * The packaging story will firm up over the next slice; for now this
 * page describes the host-native install (clone + pnpm install +
 * migrate + license activation).
 */
export function Install() {
  return (
    <div>
      <section
        style={{
          padding: "60px 24px 40px",
          textAlign: "center",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ ...container, maxWidth: 720 }}>
          <h1
            style={{
              fontSize: 40,
              margin: "0 0 16px",
              letterSpacing: -0.8,
            }}
          >
            Install on your own server
          </h1>
          <p style={{ color: "var(--text-dim)", fontSize: 17, margin: 0 }}>
            One server, PostgreSQL, Node.js. Plan on ~30 minutes for the first
            install plus another 15 for license activation.
          </p>
        </div>
      </section>

      <section style={{ padding: "60px 24px", ...container, maxWidth: 820 }}>
        <RequirementsCard />
        <Step
          number={1}
          title="Get the install bundle"
          body={
            <>
              Once your cooperative is on file with us, we'll send a download
              link to the latest stable build. The bundle is the full source
              tree plus a quickstart script.
              <p
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  color: "var(--text-dim)",
                }}
              >
                Don't have a license yet?{" "}
                <Link to="/contact">Request one →</Link>
              </p>
            </>
          }
        />
        <Step
          number={2}
          title="Prepare PostgreSQL"
          body={
            <>
              Create a database and a user with full privileges on it.
              <CodeBlock>{`# As the postgres superuser:
CREATE DATABASE smart_loan;
CREATE USER loan WITH ENCRYPTED PASSWORD 'change-me';
GRANT ALL PRIVILEGES ON DATABASE smart_loan TO loan;`}</CodeBlock>
              The default DATABASE_URL is
              <code style={codeInline}>
                postgres://loan:loan@localhost:5432/smart_loan
              </code>
              — update both halves of the password if you change it.
            </>
          }
        />
        <Step
          number={3}
          title="Install Node + pnpm + clone"
          body={
            <>
              Node 20 LTS or newer. We use pnpm because the repo is a monorepo
              with workspaces.
              <CodeBlock>{`# Node via your distro's package manager or nodesource
node --version  # should be 20.x or newer

# pnpm
npm install -g pnpm

# Clone + install
cd /opt
git clone <your-tarball-or-private-mirror> smart-loan
cd smart-loan
pnpm install`}</CodeBlock>
            </>
          }
        />
        <Step
          number={4}
          title="Configure environment"
          body={
            <>
              Copy <code style={codeInline}>.env.example</code> to{" "}
              <code style={codeInline}>.env</code> and edit. The critical
              fields:
              <CodeBlock>{`DATABASE_URL=postgres://loan:loan@localhost:5432/smart_loan
JWT_SECRET=<32+ random characters; see openssl rand -base64 32>
PORT=3001
WEB_ORIGIN=https://lending.your-coop.example
COMPANY_NAME=Your Cooperative MPC

# Optional providers — leave as MOCK to start
NOTIFICATION_PROVIDER=MOCK
PAYMENT_PROVIDER=MOCK`}</CodeBlock>
              The full list with descriptions is in{" "}
              <code style={codeInline}>.env.example</code>.
            </>
          }
        />
        <Step
          number={5}
          title="Migrate + seed the database"
          body={
            <>
              <CodeBlock>{`pnpm --filter @loan/db prisma:migrate deploy
pnpm --filter @loan/db prisma:seed`}</CodeBlock>
              The seed creates the canonical roles, default chart of accounts,
              and a bootstrap admin user. Check the seed output for the
              bootstrap password — change it immediately on first login.
            </>
          }
        />
        <Step
          number={6}
          title="Start the services"
          body={
            <>
              In production you'll run these under{" "}
              <code style={codeInline}>systemd</code> or{" "}
              <code style={codeInline}>pm2</code>. To verify it works:
              <CodeBlock>{`# Terminal 1 — the API
pnpm --filter @loan/api dev

# Terminal 2 — the web app (or build + serve via nginx)
pnpm --filter @loan/web build
# Serve apps/web/dist with your reverse proxy of choice`}</CodeBlock>
            </>
          }
        />
        <Step
          number={7}
          title="Activate your license"
          body={
            <>
              Sign in as the bootstrap admin → Settings → License → paste the
              token we issued. Features unlock based on your tier immediately.
              No internet required for verification — the signature is checked
              locally against the bundled public key.
              <p
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  color: "var(--text-dim)",
                  fontSize: 13,
                }}
              >
                The license also re-verifies on every server boot, so a tampered
                token gets caught at startup.
              </p>
            </>
          }
        />
        <FinishedCard />
      </section>
    </div>
  );
}

function RequirementsCard() {
  return (
    <div
      style={{
        padding: 24,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        marginBottom: 40,
      }}
    >
      <h3
        style={{
          fontSize: 14,
          margin: "0 0 16px",
          color: "var(--accent)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Prerequisites
      </h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 16,
          fontSize: 14,
        }}
      >
        <Req title="OS" detail="Linux (Ubuntu 22.04 LTS recommended)" />
        <Req title="Database" detail="PostgreSQL 14 or newer" />
        <Req title="Runtime" detail="Node.js 20 LTS or newer" />
        <Req title="Hardware" detail="2 vCPU, 4 GB RAM, 20 GB disk min." />
      </div>
    </div>
  );
}

function Req({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      <div style={{ color: "var(--text)", fontSize: 13 }}>{detail}</div>
    </div>
  );
}

function Step({
  number,
  title,
  body,
}: {
  number: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "48px 1fr",
        gap: 20,
        marginBottom: 32,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "var(--accent-strong)",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 14,
          fontWeight: 700,
        }}
      >
        {number}
      </div>
      <div>
        <h3 style={{ fontSize: 18, margin: "4px 0 12px" }}>{title}</h3>
        <div style={{ color: "var(--text)", fontSize: 14, lineHeight: 1.6 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      style={{
        margin: "12px 0",
        padding: 16,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.6,
        color: "var(--text)",
        overflowX: "auto",
      }}
    >
      {children}
    </pre>
  );
}

const codeInline: React.CSSProperties = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  padding: "1px 6px",
  borderRadius: 3,
  fontSize: 12,
  fontFamily: "ui-monospace, Menlo, Consolas, monospace",
};

function FinishedCard() {
  return (
    <div
      style={{
        padding: 28,
        background: "rgba(16,185,129,0.08)",
        border: "1px solid rgba(16,185,129,0.3)",
        borderRadius: 12,
        marginTop: 40,
      }}
    >
      <h3 style={{ fontSize: 18, margin: "0 0 8px", color: "var(--success)" }}>
        That's it
      </h3>
      <p
        style={{
          color: "var(--text)",
          fontSize: 14,
          margin: "0 0 16px",
          lineHeight: 1.6,
        }}
      >
        From here, everything is admin-side configuration: invite staff, create
        loan products, configure approval chains, import existing customers via
        CSV. The in-app Help drawer has feature walkthroughs.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Link to="/contact" style={btnPrimary}>
          Request a license →
        </Link>
        <Link to="/pricing" style={btnSecondary}>
          See pricing
        </Link>
      </div>
    </div>
  );
}
