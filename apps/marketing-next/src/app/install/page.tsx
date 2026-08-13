import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { PathSwitcher } from "./path-switcher";

/**
 * On-prem install guide — SERVER COMPONENT.
 *
 * Two packaged paths, Docker and bare-metal. The tab strip is the only
 * interactive element on the page and lives in ./path-switcher.tsx;
 * both guides below are rendered here, on the server, and passed into
 * it as props. See the long comment in that file — the split is the
 * pilot's most transferable finding.
 */

export const metadata: Metadata = {
  title: "Install on your own server",
  description:
    "Two packaged on-prem install paths for SmartLoan — a Docker Compose stack, or a bare-metal systemd + nginx installer.",
};

export default function InstallPage() {
  return (
    <div>
      <section className="border-b border-border px-6 pb-10 pt-[60px] text-center">
        <div className="mx-auto max-w-[720px] px-6 py-6">
          <h1 className="m-0 mb-4 text-[40px] tracking-[-0.8px]">
            Install on your own server
          </h1>
          <p className="m-0 text-[17px] text-fg-dim">
            Two packaged paths. Pick whichever matches your team&apos;s
            operational style — same software either way.
          </p>
        </div>
      </section>

      <PathSwitcher
        docker={
          <>
            <DockerPath />
            <SharedFooter />
          </>
        }
        bareMetal={
          <>
            <BareMetalPath />
            <SharedFooter />
          </>
        }
      />
    </div>
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
        Once your cooperative is on file with us, we&apos;ll send a download
        link plus your license token + public key.{" "}
        <Link href="/contact">Don&apos;t have one yet? →</Link>
      </Step>
      <Step number={2} title="Configure environment">
        From the bundle root:
        <Code>{`cd deploy/docker
cp .env.production.example .env`}</Code>
        Open <Inline>.env</Inline> and fill in the four required fields:
        <ul className={UL}>
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
        Wait for the &quot;Server listening on http://0.0.0.0:3001&quot; line.
        Migrations run automatically.
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
        Caddy handles ACME / Let&apos;s Encrypt automatically.
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
        cooperative is on file.{" "}
        <Link href="/contact">Don&apos;t have one yet? →</Link>
      </Step>
      <Step number={2} title="Extract + run the installer">
        <Code>{`tar xzf smartloan-2026-XX-XX.tar.gz
cd smartloan
sudo ./deploy/bare-metal/install.sh`}</Code>
        The script:
        <ul className={UL}>
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
    <div className="mb-8 rounded-[10px] border border-border bg-bg-elev p-6">
      <h3 className="m-0 mb-4 text-xs uppercase tracking-[0.5px] text-accent">
        Prerequisites
      </h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4 text-sm">
        {items.map((item) => (
          <div key={item.title}>
            <div className="mb-1 text-[11px] uppercase tracking-[0.5px] text-fg-muted">
              {item.title}
            </div>
            <div className="text-[13px] text-fg">{item.detail}</div>
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
  children: ReactNode;
}) {
  return (
    <div className="mb-7 grid grid-cols-[40px_1fr] gap-4">
      <div className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-accent-strong text-[13px] font-bold text-white">
        {number}
      </div>
      <div>
        <h3 className="mb-2.5 mt-1 text-base">{title}</h3>
        <div className="text-sm leading-relaxed text-fg">{children}</div>
      </div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="my-2.5 overflow-x-auto rounded-md border border-border bg-bg-elev p-3.5 font-mono text-xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

function Inline({ children }: { children: string }) {
  return (
    <code className="rounded-[3px] border border-border bg-bg-elev px-[5px] py-px font-mono text-xs">
      {children}
    </code>
  );
}

const UL = "ml-0 mt-2 list-disc pl-6 text-[13px] leading-[1.8] text-fg-dim";

function SharedFooter() {
  return (
    <div className="mt-10 rounded-xl border border-success-ring bg-success-soft p-7">
      <h3 className="m-0 mb-2 text-lg text-success">That&apos;s it</h3>
      <p className="m-0 mb-4 text-sm leading-relaxed text-fg">
        From here, everything is admin-side configuration: invite staff, create
        loan products, configure approval chains, import existing customers via
        CSV. The in-app Help drawer has feature walkthroughs.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href="/contact" className="btn-primary">
          Request a license →
        </Link>
        <Link href="/pricing" className="btn-secondary">
          See pricing
        </Link>
      </div>
    </div>
  );
}
