# Backup + restore

Two scripts, both bash:

- **`backup.sh`** — `pg_dump`s the database per schema, rotates locally,
  optionally pushes to S3. Designed to run from cron.
- **`restore.sh`** — inverse. Restores from any dump produced by
  `backup.sh`; refuses to run against a non-empty DB unless `--force`.

The pair are designed to work in both single-tenant and multi-tenant
modes — `backup.sh` reads `MULTI_TENANT` and adjusts what it dumps.

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

You haven't tested a restore until you've restored. Run this drill
quarterly against a non-production DB:

```bash
# 1. Pick yesterday's dump
DUMP=$(ls -t /var/backups/smart-loan/daily/*-full.sql.gz | head -1)

# 2. Spin up a scratch DB
createdb smart_loan_restore_test

# 3. Restore into it
DATABASE_URL=postgresql://app:pw@localhost/smart_loan_restore_test \
  ./restore.sh "$DUMP"

# 4. Verify row counts match production (rough sanity check)
psql postgresql://app:pw@localhost/smart_loan_restore_test \
  -c 'SELECT count(*) FROM "Customer"; SELECT count(*) FROM "LoanApplication";'

# 5. Cleanup
dropdb smart_loan_restore_test
```

If step 3 fails, the dump is corrupt. If step 4 returns wildly
different numbers, the backup window or the dump scope is wrong.
Either is a P0 you'd rather find now than during an actual outage.

## Per-tenant restore (multi-tenant mode)

When a single tenant's data is corrupted but the rest is fine:

```bash
DATABASE_URL=postgresql://app:pw@db/production \
  ./restore.sh /var/backups/smart-loan/daily/20260523T023000-tenant-acme.sql.gz
```

This drops + restores only `tenant_acme`; other tenants stay untouched.
The `--clean --if-exists` flags in the dump ensure idempotency.
