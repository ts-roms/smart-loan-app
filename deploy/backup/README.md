# Backup + restore

Three scripts, all bash, plus a verifier:

- **`backup.sh`** — `pg_dump`s the database per schema, archives
  `UPLOADS_DIR`, rotates locally, optionally pushes to S3. Runs from cron.
- **`restore.sh`** — inverse. Restores dumps **and** the uploads archive
  into an **explicitly named target**; refuses to touch the database in
  `DATABASE_URL` without `--force`.
- **`drill.sh`** — the whole restore drill as one command: baseline →
  backup → restore into a scratch DB → migration status → verify.
- **`libs/db/scripts/verify-restore.mjs`** — the verification. Row counts
  against a pre-backup baseline, the five reconciliation checks re-run on
  the restored database, and an uploads manifest digest.

The scripts are designed to work in both single-tenant and multi-tenant
modes — `backup.sh` reads `MULTI_TENANT` and adjusts what it dumps.

> **Client tool versions matter.** `pg_dump` must match the server's
> major version. A newer `pg_dump` writes a header the older server
> rejects, producing a dump that looks fine and cannot be restored. The
> drill found exactly this; see `docs/modernization/disaster-recovery.md`.
> `backup.sh` now warns when it detects the skew.

## Daily backup setup

1. Copy `backup.sh` to the API host: `/opt/smart-loan/deploy/backup/`.
2. Ensure `pg_dump` is on PATH (Postgres client tools, matching the
   server's major version) and the host can reach Postgres.
3. Set `DATABASE_URL`, `MULTI_TENANT` (matching the API's `.env`).
4. Add to root's crontab:
   ```
   30 2 * * *  /opt/smart-loan/deploy/backup/backup.sh \
                  >> /var/log/smart-loan-backup.log 2>&1
   ```
5. On Sundays, dumps are also promoted to `weekly/` and kept longer
   (default 8 weeks). Daily dumps roll off after 14 days.

## Off-site sync

Set `BACKUP_S3_BUCKET=s3://your-bucket/path` (and `BACKUP_S3_ENDPOINT`
if using DO Spaces / R2 / MinIO). The script uses `aws s3 sync` so
incremental uploads are cheap. AWS creds via the normal env vars.

## Restore drill (every quarter)

You haven't tested a restore until you've restored. One command, from
the repo root, against the live database as the source:

```bash
DATABASE_URL=postgresql://app:pw@db/production \
UPLOADS_DIR=/srv/smart-loan/uploads \
  bash deploy/backup/drill.sh
```

It records a baseline, runs the real `backup.sh`, restores into a
throwaway `smart_loan_drill` database, checks `prisma migrate status`,
then verifies row counts + reconciliation + the uploads manifest. Exit 0
means the backup is a backup. It drops the scratch database afterwards
unless you pass `--keep`.

The drill needs the repo checked out with dependencies installed, since
the verification imports `libs/db/src/lib/reconciliation.ts`. A backup
host carrying only `psql` can restore but cannot verify.

Last run and its findings: `docs/modernization/disaster-recovery.md`.

## Restoring for real

`restore.sh` never infers its target. Name it:

```bash
# into a scratch database (what the drill does)
./restore.sh --target smart_loan_drill --create --uploads-dir /tmp/u \
  /var/backups/smart-loan/daily/20260812T023000-full.sql.gz \
  /var/backups/smart-loan/daily/20260812T023000-uploads.tar.gz

# over the live database — the real thing, hence --force
./restore.sh --target smart_loan --force --uploads-dir /srv/smart-loan/uploads \
  /var/backups/smart-loan/daily/20260812T023000-full.sql.gz \
  /var/backups/smart-loan/daily/20260812T023000-uploads.tar.gz
```

Without `--force` it refuses any target that resolves to `DATABASE_URL`,
checked both textually and by cluster fingerprint — so
`127.0.0.1` instead of `localhost` does not get past it.

## Per-tenant restore (multi-tenant mode)

When a single tenant's data is corrupted but the rest is fine:

```bash
DATABASE_URL=postgresql://app:pw@db/production \
  ./restore.sh --target smart_loan --force \
    /var/backups/smart-loan/daily/20260523T023000-tenant-acme.sql.gz
```

This drops + restores only `tenant_acme`; other tenants stay untouched.
The `--clean --if-exists` flags in the dump ensure idempotency. `--force`
is required because the target _is_ the production database — that is
the point of a per-tenant restore, and it should still be typed
deliberately.
