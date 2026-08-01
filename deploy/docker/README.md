# SmartLoan on-prem — Docker install

Production deployment of SmartLoan as a self-contained Docker compose
stack. Suitable for a cooperative running a single Linux server with
Docker installed. ~10 minutes from clone to login.

If your cooperative doesn't run Docker, use `deploy/bare-metal/`
instead — same software, different packaging.

## Prerequisites

- Linux host with at least 2 vCPU, 4 GB RAM, 20 GB disk
- Docker Engine 24+ with the Compose plugin (`docker compose version`
  should print a v2.x string)
- A public DNS hostname pointing at the host, and a TLS-terminating
  reverse proxy in front (Caddy, nginx, Traefik — your choice). The
  stack publishes plain HTTP on port `WEB_PORT` (8080 by default);
  it does NOT do TLS itself.
- Your SmartLoan license + the vendor's public key (PEM). Both
  delivered to you when you purchased the license.

## First-time install

```sh
# From the repo root
cp deploy/docker/.env.production.example deploy/docker/.env

# Fill in the REQUIRED values in deploy/docker/.env:
#   POSTGRES_PASSWORD          random, long
#   JWT_SECRET                 32+ chars (openssl rand -base64 48)
#   WEB_ORIGIN                 https://lending.your-coop.example
#   LICENSE_PUBLIC_KEY_PEM     the PEM from your vendor

# Build, start, wait for healthy, then seed. ~5 min on the first run
# (the image build dominates); cached and under a minute afterwards.
pnpm docker:up:seed
```

The seed prints a bootstrap admin email + password. Sign in at
`http://localhost:8080` (or your `WEB_ORIGIN`), **change the password
immediately**, then go to Settings → License to paste your
vendor-issued license token.

`pnpm docker:up:seed` is two steps you can also run separately —
`pnpm docker:up` then `pnpm docker:seed`. Spelled out without pnpm:

```sh
cd deploy/docker
docker compose up -d --build --wait   # returns once api + web are healthy
docker compose run --rm seed          # one-shot seeder, prints the creds
```

Seeding is idempotent (every write is an upsert, nothing is deleted),
so re-running `pnpm docker:seed` after an upgrade is safe — it just
adds any new default products, rules or permissions the release
introduced.

## Command reference

All run from the repo root; each is a thin wrapper over
`docker compose -f deploy/docker/docker-compose.yml`.

| Command               | What it does                                         |
| --------------------- | ---------------------------------------------------- |
| `pnpm docker:up:seed` | Build + start + wait for healthy + seed. Start here. |
| `pnpm docker:up`      | Build + start + wait for healthy. No data written.   |
| `pnpm docker:seed`    | Run the one-shot seeder against a running stack.     |
| `pnpm docker:build`   | Build the images only.                               |
| `pnpm docker:ps`      | Service status.                                      |
| `pnpm docker:logs`    | Tail logs for every service.                         |
| `pnpm docker:down`    | Stop and remove containers. Volumes survive.         |
| `pnpm docker:reset`   | Same, **plus deletes the DB and uploads volumes**.   |

`pnpm docker:reset` is destructive and unrecoverable without a backup.
It exists for rebuilding a test install from scratch; don't point it at
production.

## Day-2 operations

### View logs

```sh
docker compose logs -f api
docker compose logs -f web
docker compose logs -f db
```

### Restart a service

```sh
docker compose restart api
```

### Update to a new release

```sh
# Pull the new source (or extract the new bundle from your vendor)
git pull

# Rebuild images and restart only what changed
pnpm docker:up

# Optional: pick up any new default products / rules / permissions
# the release ships. Safe on an install with live data — upserts only.
pnpm docker:seed
```

Migrations run automatically on api container start — no manual step
needed for schema updates.

### Backups

The data lives in two named Docker volumes:

```sh
docker volume ls | grep smartloan
# smartloan_smartloan-db-data       — Postgres data files
# smartloan_smartloan-uploads       — KYC docs, customer ID scans, etc.
```

For Postgres, prefer a logical dump (transactionally consistent):

```sh
docker compose exec db pg_dump -U loan smart_loan > backup-$(date +%F).sql
```

For uploads, snapshot the volume:

```sh
docker run --rm -v smartloan_smartloan-uploads:/data \
  -v $(pwd):/backup alpine \
  tar czf /backup/uploads-$(date +%F).tar.gz -C /data .
```

Cron these to a backup target you trust. Keep at least 30 days.

### Restoring from backup

```sh
# Postgres (destructive — drops the existing DB)
docker compose exec -T db psql -U loan -d postgres -c "DROP DATABASE smart_loan;"
docker compose exec -T db psql -U loan -d postgres -c "CREATE DATABASE smart_loan;"
docker compose exec -T db psql -U loan -d smart_loan < backup-2026-05-22.sql

# Uploads
docker run --rm -v smartloan_smartloan-uploads:/data \
  -v $(pwd):/backup alpine \
  tar xzf /backup/uploads-2026-05-22.tar.gz -C /data
```

## Putting TLS in front

The compose stack ships plain HTTP on port `WEB_PORT`. Stick your
existing reverse proxy in front of it. Example Caddy config:

```
lending.your-coop.example {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy handles ACME / Let's Encrypt automatically.

## Troubleshooting

**"Tenant license not found / invalid" on every API call**
The license PEM in `.env` is malformed or doesn't match the license
token. Verify by visiting Settings → License in the UI; the error
there will be more specific. Common gotcha: the `\n` in
`LICENSE_PUBLIC_KEY_PEM` must be literal `\n` characters inside the
.env value, not real newlines.

**"Database does not exist"**
The api container started before Postgres was ready. Should resolve
itself on the next restart — the api's `depends_on` waits for the
healthcheck, but the very first boot can race. Try:
`docker compose restart api`.

**Migration error on update**
A migration is failing — usually a schema drift from a previous
manual change. Capture the error log and reach out; don't
`prisma migrate resolve` without guidance, it can corrupt the
migrations table.

**Out of disk space**
Most likely culprits: the `smartloan-uploads` volume (KYC docs) or
Postgres bloat. `docker system df -v` shows volume sizes.
