# SmartLoan deployment

Two packaged paths to a production install for cooperatives running
SmartLoan on their own server.

| Path                                    | Best for                                                                          | Time-to-running |
| --------------------------------------- | --------------------------------------------------------------------------------- | --------------- |
| [`docker/`](./docker/README.md)         | IT shops comfortable with containers. `docker compose up -d` and you're 90% done. | ~15 min         |
| [`bare-metal/`](./bare-metal/README.md) | Traditional Linux admins. Native systemd service, nginx in front.                 | ~30 min         |

Both deliver the same software. Same database schema, same features,
same license activation flow. The choice is purely operational — what
your team already knows how to run.

## What gets deployed

Either path ships:

- **`@loan/api`** — the Fastify backend (port 3001, internal)
- **`@loan/web`** — the tenant SPA (cooperative staff + borrower UI)
- **PostgreSQL** — local install on the same host

The platform console (`apps/platform`) and the marketing site
(`apps/marketing`) are vendor-side apps and do **not** get deployed
to cooperatives. They stay on the vendor's infrastructure.

## What you need beforehand

- A Linux server (Ubuntu 22.04 LTS / 24.04 LTS recommended)
- A DNS hostname pointing at it
- A reverse proxy in front for TLS (nginx + certbot, Caddy, or
  Traefik — your choice)
- Your SmartLoan license token + public key, delivered when you
  purchased

## Choosing between paths

**Pick Docker if:**

- You already run other Docker workloads on this host
- You prefer immutable images + declarative compose files
- You want trivial rollback (`docker compose down && checkout prev && up`)
- You don't want to manage Node + PostgreSQL versions yourself

**Pick bare-metal if:**

- You don't run any containers today and don't want to start
- You have a strong systemd / nginx / Postgres workflow already
- Your security team needs visibility into every process at the
  host level
- You want to share Postgres with other services on the same host

You can switch between them later if you change your mind — both
read from the same Postgres DB and the same uploads directory, so
migrating is "stop one, start the other, point at the same data".

## After you're up

1. Sign in with the bootstrap admin (credentials shown on first
   install)
2. Change the password immediately
3. Go to Settings → License and paste your vendor-issued token
4. Settings → Branding to customize the cooperative name, logo,
   theme color
5. Admin → Users to invite staff
6. Loan Products → create your first product

The in-app Help drawer covers each module in depth — every page
has a "Take a tour" button.

## License activation

The Ed25519-signed license token is verified locally against the
public key you set in the env. No network call to the vendor is
needed at any point — your install works offline indefinitely.

If verification fails on boot, the API runs in "unlicensed grace
mode" (read-only for licensed features). The login screen surfaces
a clear error pointing at Settings → License.

## Updates

Both paths support in-place updates. Migrations are idempotent and
run automatically (Docker) or via the installer (bare-metal). See
the path-specific README for the exact procedure.

## Support

Production support comes with your license. Reach out via the email
on your license agreement.
