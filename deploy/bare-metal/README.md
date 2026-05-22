# SmartLoan on-prem — bare-metal install

Production deployment of SmartLoan on a Linux host, without Docker.
For cooperatives whose IT shop runs services as systemd units rather
than containers.

If your team is comfortable with Docker, use `deploy/docker/` instead
— same software, less work.

## What this installs

- **PostgreSQL 16** (from the distro package)
- **Node.js 20 LTS** (from NodeSource)
- **pnpm** (via corepack)
- **SmartLoan source** at `/opt/smartloan` (configurable)
- **systemd unit** `smartloan-api.service` running on `127.0.0.1:3001`
- **A built tenant web SPA** at `/opt/smartloan/apps/web/dist`

It does NOT install or configure nginx — that's a host-level concern
covered in the `nginx/smartloan.conf.example` template.

## Prerequisites

- Linux host (Ubuntu 22.04 LTS or 24.04 LTS recommended)
- 2 vCPU, 4 GB RAM, 20 GB disk
- A user with sudo access
- A public DNS hostname pointing at the host
- Your SmartLoan license + the vendor's public key (PEM), delivered
  when you purchased the license

## Install

```sh
# From the repo root (the installer can also run from the install
# bundle we ship — same script either way).
sudo ./deploy/bare-metal/install.sh
```

The script:

1. Verifies / installs Node, pnpm, PostgreSQL
2. Creates a `smartloan` service user
3. Creates the `smart_loan` database + `loan` user with a random
   strong password (recorded in the env file)
4. Copies the source to `/opt/smartloan` (default; override with
   `--source-dir`)
5. Runs `pnpm install` + `prisma generate`
6. Writes `/etc/smartloan/smartloan.env` with sensible defaults
7. Runs `prisma migrate deploy`
8. Runs the seed if the database is empty (prints the bootstrap
   admin credentials)
9. Builds the tenant web app
10. Installs + starts the systemd unit

It's idempotent — rerunning skips steps that have already been done.

## Set up TLS + reverse proxy

The API listens on `127.0.0.1:3001` — not exposed to the public network.
You need an nginx (or Caddy / Traefik) in front to:

- Terminate TLS
- Serve the static SPA from `/opt/smartloan/apps/web/dist`
- Proxy `/api/v1/*` and `/uploads/*` to `127.0.0.1:3001`

A starter nginx config is at `deploy/bare-metal/nginx/smartloan.conf.example`.
Adjust the hostname, then:

```sh
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp deploy/bare-metal/nginx/smartloan.conf.example \
       /etc/nginx/sites-available/smartloan.conf
sudo ln -s /etc/nginx/sites-available/smartloan.conf \
           /etc/nginx/sites-enabled/

# Edit the file to replace `lending.your-coop.example` with your real
# hostname, then ask certbot to install a Let's Encrypt cert:
sudo certbot --nginx -d lending.your-coop.example
sudo systemctl reload nginx
```

## Activate your license

Edit `/etc/smartloan/smartloan.env` and paste your vendor-issued public
key into `LICENSE_PUBLIC_KEY_PEM`. The PEM must be on one line with
newlines escaped as `\n`:

```
LICENSE_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----\nMC...\n-----END PUBLIC KEY-----\n"
```

Then:

```sh
sudo systemctl restart smartloan-api
```

Sign in to the web UI with the bootstrap admin (credentials in the
installer output), change the password, then visit Settings → License
and paste the license token your vendor issued.

## Day-2 operations

### Service control

```sh
systemctl status smartloan-api
systemctl restart smartloan-api
journalctl -u smartloan-api -f
```

### Backups

```sh
# Postgres
sudo -u postgres pg_dump smart_loan > backup-$(date +%F).sql

# Uploads
tar czf uploads-$(date +%F).tar.gz -C /opt/smartloan uploads/
```

Cron these to a backup target. Retain 30 days minimum.

### Updates

```sh
cd /opt/smartloan
sudo -u smartloan git pull   # or extract the new bundle from your vendor
sudo -u smartloan pnpm install --frozen-lockfile
sudo -u smartloan pnpm --filter @loan/db prisma:generate
sudo -u smartloan pnpm --filter @loan/db exec prisma migrate deploy
sudo -u smartloan pnpm --filter @loan/web build
sudo systemctl restart smartloan-api
```

For the brave / lazy: re-running `deploy/bare-metal/install.sh` against
an existing install does all of the above (idempotently).

## Restoring from backup

```sh
# Stop the service so nothing is mid-flight in the DB.
sudo systemctl stop smartloan-api

# Postgres (destructive)
sudo -u postgres psql -c "DROP DATABASE smart_loan;"
sudo -u postgres psql -c "CREATE DATABASE smart_loan OWNER loan;"
sudo -u postgres psql smart_loan < backup-2026-05-22.sql

# Uploads
sudo tar xzf uploads-2026-05-22.tar.gz -C /opt/smartloan/

# Bring it back
sudo systemctl start smartloan-api
```

## Troubleshooting

**`Active: failed` on the systemd unit**
Check `journalctl -u smartloan-api --no-pager -n 200`. The most
common causes are a malformed `LICENSE_PUBLIC_KEY_PEM` and a wrong
`DATABASE_URL`.

**Migrations fail on update**
Capture the error. Don't run `prisma migrate resolve` blindly — it
can corrupt the migrations table. Reach out before reaching for
that hammer.

**"Permission denied" writing to /opt/smartloan**
The service user should own the tree:

```
sudo chown -R smartloan:smartloan /opt/smartloan
```

**nginx 502 Bad Gateway**
The API isn't responding on `127.0.0.1:3001`. Check the unit status
and journal.
