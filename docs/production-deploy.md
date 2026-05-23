# Production deployment walkthrough

Single-tenant on-prem deploy of Smart Loan to a fresh Linux host
(Ubuntu 22.04 LTS / Debian 12 / Hetzner CX21 / DigitalOcean basic).
Multi-tenant SaaS deploy is the same plus the cutover (see
[`multi-tenant-cutover.md`](./multi-tenant-cutover.md)).

Goal: get one paying customer live in under a day from a clean box.
Estimated wall-clock time, end to end: ~3 hours including the
30-min smoke test.

## §1 — Pre-requisites

On your local machine:

- This repo, on the release tag you intend to ship.
- A domain (or subdomain) pointing at the target host's IP. You can
  add the DNS A record at any time — Caddy will fetch the cert
  automatically once it resolves.
- An SMTP account (SendGrid / Mailgun / Postmark / SES) so
  notifications can actually send. The MOCK provider works for the
  smoke test but you'll want real mail before going live.

On the target host:

- SSH access as a sudoer with `ufw` + `unattended-upgrades` already
  configured (`apt install unattended-upgrades` if not — security
  updates auto-applied is the bare minimum).

## §2 — Choose a packaging path

Smart Loan ships two: **Docker** and **bare-metal**. Both produce the
same runtime. Pick based on what you (or the customer) operates more
confidently:

| Aspect           | Docker (`deploy/docker/`)                            | Bare-metal (`deploy/bare-metal/`) |
| ---------------- | ---------------------------------------------------- | --------------------------------- |
| First boot       | 1× `docker compose up -d`                            | 1× `sudo ./install.sh`            |
| Postgres         | Containerised (in-stack)                             | System service via `apt`          |
| Cert renewal     | Caddy in the stack                                   | Nginx + certbot timer             |
| Memory floor     | ~600 MB (with DB)                                    | ~350 MB (DB separate)             |
| Customer comfort | "It's just a container"                              | "I want files I can `cat`"        |
| Backup script    | runs inside the host crontab; same script either way |

The walkthrough below uses **bare-metal** because it's the more
common "first paying tenant" scenario (the customer wants to host on
their own VM). Docker is essentially the same recipe with
`docker compose` instead of `systemctl`.

## §3 — Bare-metal install

The full installer is in `deploy/bare-metal/install.sh` — read it
before running. Bullet summary of what it does:

1. `apt install` Node 20, Postgres 16, nginx, certbot, jq.
2. Creates the `smartloan` system user + `/opt/smart-loan` directory.
3. Clones the repo, runs `pnpm install --prod=false`, builds.
4. Provisions Postgres role + DB.
5. Generates a strong `JWT_SECRET` + writes `/etc/smart-loan/.env`.
6. Writes systemd unit files (`smart-loan-api.service`,
   `smart-loan-jobs.timer` — though the timer is no longer needed
   post-P2.11 since the scheduler lives in-process).
7. Renders the nginx site config from the template, pointing at the
   API + web ports.
8. Runs the schema migrations.
9. Prints the bootstrap admin email + temp password.

Run it:

```bash
ssh deploy@your-host
git clone https://github.com/your-org/smart-loan-app /tmp/smart-loan
cd /tmp/smart-loan/deploy/bare-metal
sudo DOMAIN=app.example.com ADMIN_EMAIL=ops@yours.com ./install.sh
```

(`DOMAIN` is the only required env; everything else has defaults.)

When the script finishes:

- `https://app.example.com` serves the web app (after certbot picks
  up the cert).
- `https://app.example.com/api/v1/health/live` returns `{"ok":true}`.
- `/etc/smart-loan/.env` has the generated secrets. **Copy this to
  your password manager and `chmod 600` the file.**

## §4 — Smoke test the install

Use the script's printed bootstrap admin to do a 5-minute end-to-end:

1. Sign in at `https://app.example.com/login`.
2. Settings → Branding → set the cooperative name + logo.
3. New Customer → fill in one row. Confirm KYC status shows
   `INCOMPLETE`.
4. Apply for Loan (officer side) → check that the agreement PDF
   renders (officer side).
5. Disburse → check `/accounting` shows the journal entry.
6. Record payment → check the schedule updates.

If any of those break, **don't go live** — they're the happy path
the customer will run on day one.

## §5 — Configure off-host backup

```bash
sudo cp /opt/smart-loan/deploy/backup/backup.sh /usr/local/bin/smart-loan-backup
sudo chmod +x /usr/local/bin/smart-loan-backup

# Edit /etc/cron.d/smart-loan-backup:
30 2 * * * smartloan  /usr/local/bin/smart-loan-backup >> /var/log/smart-loan-backup.log 2>&1
```

If you have S3-compatible offsite storage (highly recommended):

```bash
# In /etc/smart-loan/.env:
BACKUP_S3_BUCKET=s3://acme-coop-backups/smart-loan
# (plus AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
```

After ~25 hours, confirm:

```bash
ls -la /var/backups/smart-loan/daily/
aws s3 ls s3://acme-coop-backups/smart-loan/daily/  # if S3
```

If both look right, run the §6 restore drill once before declaring
the install done.

## §6 — First restore drill

Simulate "the host died and we need to bring a new one up."

1. Spin up a second, empty Postgres (same major version) — a local
   `docker run postgres:16` is fine for the drill.
2. Copy yesterday's dump there:
   ```bash
   scp deploy@old-host:/var/backups/smart-loan/daily/$(date -d yesterday +%Y%m%d)T*-full.sql.gz .
   ```
3. Restore:
   ```bash
   DATABASE_URL=postgresql://postgres:pw@localhost:5432/drill \
     /opt/smart-loan/deploy/backup/restore.sh ./*-full.sql.gz
   ```
4. Compare row counts vs production for the top tables:
   ```bash
   for t in Customer LoanApplication LoanPayment JournalEntry; do
     prod=$(psql $PROD_URL -At -c "SELECT count(*) FROM \"$t\";")
     drill=$(psql $DRILL_URL -At -c "SELECT count(*) FROM \"$t\";")
     echo "$t: prod=$prod drill=$drill"
   done
   ```

If row counts match within the backup window, you're done. Repeat
this drill every quarter — a backup you haven't tested is a backup
you don't have.

## §7 — Observability checklist

Minimum viable production telemetry, before customer traffic starts:

- **`SENTRY_DSN`** in `.env`. Every 5xx now ships to Sentry with the
  tenant slug attached (single-tenant = `default`). Set up a Slack
  notification channel in Sentry for any new issue.
- **`/health/ready`** monitored externally (UptimeRobot / Pingdom /
  Better Stack). Page on consecutive failures.
- **Disk-usage alert** on the Postgres data dir. The schema is
  growth-friendly (no unbounded JSON columns) but uploads can
  surprise you.
- **Backup log** tailing — Better Stack / Datadog watching
  `/var/log/smart-loan-backup.log` for the daily "done in Ns" line.
  Alert if it doesn't appear by 03:00.

If you're operating multiple tenants, also:

- **Per-tenant connection count** dashboard (`pg_stat_activity`
  grouped by `application_name`). Each tenant should stay at or
  below `PER_TENANT_CONNECTION_LIMIT` (default 3).
- **Scheduler tick rate.** The TenantScheduler runs every minute and
  logs `tickAll` start/end. Missing log lines = the scheduler isn't
  ticking.

## §8 — Go-live checklist

Before announcing "live" to the customer:

- [ ] §4 smoke test passes end to end on the production install.
- [ ] §6 restore drill completed in the last 7 days.
- [ ] `SENTRY_DSN` set; one test error confirmed received.
- [ ] Backup ran at least once + uploaded to S3.
- [ ] DNS A record propagated; HTTPS cert valid.
- [ ] `JWT_SECRET` rotated from any default. (`openssl rand -hex 32`)
- [ ] Bootstrap admin password changed from the temp one printed
      during install.
- [ ] License token activated and `/api/v1/license/status` returns
      `status: "ACTIVE"`.
- [ ] Customer support has read [`runbooks.md`](./runbooks.md).
- [ ] Customer admin has been onboarded to the platform console
      (multi-tenant) or to their own admin account (single-tenant).

When all eight pass, you can ship the "we're live" email.
