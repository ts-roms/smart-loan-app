import { useState } from "react";
import { Link } from "react-router-dom";

import { btnPrimary, btnSecondary, container } from "../App";

/**
 * On-prem install guide. Two packaged paths — Docker (compose stack)
 * and bare-metal (systemd + nginx). A tab switcher lets visitors pick
 * the path that matches their ops style before committing to read.
 */

type Path = "docker" | "bare-metal";

export function Install() {
  const [path, setPath] = useState<Path>("docker");

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
            Two packaged paths. Pick whichever matches your team's operational
            style — same software either way.
          </p>
        </div>
      </section>

      <section style={{ padding: "40px 24px 0", ...container, maxWidth: 820 }}>
        <PathSwitcher path={path} onChange={setPath} />
      </section>

      <section
        style={{ padding: "32px 24px 60px", ...container, maxWidth: 820 }}
      >
        {path === "docker" ? <DockerPath /> : <BareMetalPath />}
        <SharedFooter />
      </section>
    </div>
  );
}

function PathSwitcher({
  path,
  onChange,
}: {
  path: Path;
  onChange: (p: Path) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      <PathCard
        active={path === "docker"}
        onClick={() => onChange("docker")}
        title="Docker"
        subtitle="docker compose up -d"
        body="Single compose file. PostgreSQL, API, and web ship as images. Easiest path if your team already runs containers."
        timeToRunning="~15 min"
      />
      <PathCard
        active={path === "bare-metal"}
        onClick={() => onChange("bare-metal")}
        title="Bare-metal"
        subtitle="systemd + nginx"
        body="Single install.sh sets up Node, Postgres, the service, and an nginx config. Native daemon, no container runtime."
        timeToRunning="~30 min"
      />
    </div>
  );
}

function PathCard({
  active,
  onClick,
  title,
  subtitle,
  body,
  timeToRunning,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  body: string;
  timeToRunning: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        padding: 20,
        background: active ? "var(--accent-soft)" : "var(--bg-elev)",
        border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: 10,
        cursor: "pointer",
        color: "var(--text)",
        fontFamily: "inherit",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
        }}
      >
        <h3 style={{ fontSize: 18, margin: 0 }}>{title}</h3>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {timeToRunning}
        </span>
      </div>
      <code
        style={{
          fontSize: 12,
          color: "var(--accent)",
          background: "transparent",
          padding: 0,
        }}
      >
        {subtitle}
      </code>
      <p
        style={{
          color: "var(--text-dim)",
          fontSize: 13,
          lineHeight: 1.5,
          margin: "10px 0 0",
        }}
      >
        {body}
      </p>
    </button>
  );
}

function DockerPath() {
  return (
    <div>
      <RequirementsCard
        items={[
          { title: "OS", detail: "Linux (Ubuntu 22.04+, Debian 12+)" },
          { title: "Runtime", detail: "Docker Engine 24+ with Compose plugin" },
          { title: "Hardware", detail: "2 vCPU, 4 GB RAM, 20 GB disk min." },
          { title: "Public DNS", detail: "Hostname + reverse proxy for TLS" },
        ]}
      />
      <Step number={1} title="Get the install bundle">
        Once your cooperative is on file with us, we'll send a download link
        plus your license token + public key.{" "}
        <Link to="/contact">Don't have one yet? →</Link>
      </Step>
      <Step number={2} title="Configure environment">
        From the bundle root:
        <Code>{`cd deploy/docker
cp .env.production.example .env`}</Code>
        Open <Inline>.env</Inline> and fill in the four required fields:
        <ul style={ulStyle}>
          <li>
            <Inline>POSTGRES_PASSWORD</Inline> — random, long
          </li>
          <li>
            <Inline>JWT_SECRET</Inline> —{" "}
            <Inline>openssl rand -base64 48</Inline>
          </li>
          <li>
            <Inline>WEB_ORIGIN</Inline> — your public URL, e.g.{" "}
            <Inline>https://lending.your-coop.example</Inline>
          </li>
          <li>
            <Inline>LICENSE_PUBLIC_KEY_PEM</Inline> — the PEM your vendor sent
          </li>
        </ul>
      </Step>
      <Step number={3} title="Bring up the stack">
        <Code>{`docker compose build
docker compose up -d
docker compose logs -f api`}</Code>
        Wait for the "Server listening on http://0.0.0.0:3001" line. Migrations
        run automatically.
      </Step>
      <Step number={4} title="Seed the first admin">
        <Code>{`docker compose exec api pnpm --filter @loan/db prisma:seed`}</Code>
        The seed prints a bootstrap admin email + password. Sign in, change the
        password immediately.
      </Step>
      <Step number={5} title="Put TLS in front">
        The stack listens on plain HTTP (port 8080 by default). Point your
        existing reverse proxy at it. With Caddy:
        <Code>{`lending.your-coop.example {
  reverse_proxy 127.0.0.1:8080
}`}</Code>
        Caddy handles ACME / Let's Encrypt automatically.
      </Step>
      <Step number={6} title="Activate your license">
        Sign in → Settings → License → paste your token. Features unlock based
        on tier immediately. No internet required for verification.
      </Step>
    </div>
  );
}

function BareMetalPath() {
  return (
    <div>
      <RequirementsCard
        items={[
          { title: "OS", detail: "Ubuntu 22.04 LTS or 24.04 LTS" },
          {
            title: "Runtime",
            detail: "(installer adds Node 20 + Postgres 16)",
          },
          { title: "Hardware", detail: "2 vCPU, 4 GB RAM, 20 GB disk min." },
          { title: "Access", detail: "sudo / root on the host" },
        ]}
      />
      <Step number={1} title="Get the install bundle">
        We send a tarball + your license token + public key when your
        cooperative is on file. <Link to="/contact">Don't have one yet? →</Link>
      </Step>
      <Step number={2} title="Extract + run the installer">
        <Code>{`tar xzf smartloan-2026-XX-XX.tar.gz
cd smartloan
sudo ./deploy/bare-metal/install.sh`}</Code>
        The script:
        <ul style={ulStyle}>
          <li>Installs Node 20 (NodeSource), pnpm, PostgreSQL 16</li>
          <li>
            Creates a <Inline>smartloan</Inline> service user
          </li>
          <li>Creates the database with a random strong password</li>
          <li>
            Copies source to <Inline>/opt/smartloan</Inline>
          </li>
          <li>Runs migrations + the bootstrap seed</li>
          <li>
            Installs a systemd unit <Inline>smartloan-api.service</Inline>
          </li>
        </ul>
        Idempotent — re-run anytime. ~10 minutes on a fresh host.
      </Step>
      <Step number={3} title="Paste the license public key">
        <Code>{`sudo nano /etc/smartloan/smartloan.env
# fill in LICENSE_PUBLIC_KEY_PEM with the PEM your vendor sent

sudo systemctl restart smartloan-api`}</Code>
      </Step>
      <Step number={4} title="Set up nginx + TLS">
        <Code>{`sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /opt/smartloan/deploy/bare-metal/nginx/smartloan.conf.example \\
       /etc/nginx/sites-available/smartloan.conf

# Edit the file to replace lending.your-coop.example with your hostname
sudo ln -s /etc/nginx/sites-available/smartloan.conf \\
           /etc/nginx/sites-enabled/

sudo certbot --nginx -d lending.your-coop.example
sudo systemctl reload nginx`}</Code>
      </Step>
      <Step number={5} title="Activate your license">
        Sign in with the bootstrap admin (credentials in the installer output) →
        Settings → License → paste your token.
      </Step>
    </div>
  );
}

function RequirementsCard({
  items,
}: {
  items: Array<{ title: string; detail: string }>;
}) {
  return (
    <div
      style={{
        padding: 24,
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        marginBottom: 32,
      }}
    >
      <h3
        style={{
          fontSize: 12,
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
        {items.map((item) => (
          <div key={item.title}>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginBottom: 4,
              }}
            >
              {item.title}
            </div>
            <div style={{ color: "var(--text)", fontSize: 13 }}>
              {item.detail}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "40px 1fr",
        gap: 16,
        marginBottom: 28,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          background: "var(--accent-strong)",
          color: "white",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {number}
      </div>
      <div>
        <h3 style={{ fontSize: 16, margin: "4px 0 10px" }}>{title}</h3>
        <div style={{ color: "var(--text)", fontSize: 14, lineHeight: 1.6 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre
      style={{
        margin: "10px 0",
        padding: 14,
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

function Inline({ children }: { children: string }) {
  return (
    <code
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        padding: "1px 5px",
        borderRadius: 3,
        fontSize: 12,
        fontFamily: "ui-monospace, Menlo, Consolas, monospace",
      }}
    >
      {children}
    </code>
  );
}

const ulStyle: React.CSSProperties = {
  margin: "8px 0 0 0",
  paddingLeft: 24,
  color: "var(--text-dim)",
  fontSize: 13,
  lineHeight: 1.8,
};

function SharedFooter() {
  return (
    <div
      style={{
        padding: 28,
        background: "var(--success-soft)",
        border: "1px solid var(--success-ring)",
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
