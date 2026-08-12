# Disaster Recovery

§69. What exists, what is missing, and the drill — run on 12 Aug 2026,
with the findings below.

---

## What exists

`deploy/backup/backup.sh`, `restore.sh` and `drill.sh`, plus
`libs/db/scripts/verify-restore.mjs`, with a README.

**backup.sh** — one script, two modes selected by `MULTI_TENANT`:

| Mode                   | Behaviour                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MULTI_TENANT != true` | dumps the whole database, one file per night                                                                         |
| `MULTI_TENANT == true` | dumps `public.*` **plus each tenant schema separately**, so restoring one tenant does not require restoring everyone |

- **Rotation:** N days of full backups, M weeks of weeklies. Filename-based, so
  there is no metadata file that can drift out of sync with reality.
- **Storage:** `${BACKUP_DIR:-/var/backups/smart-loan/}`, with an optional
  `s3 sync` to `BACKUP_S3_BUCKET` for offsite. **Off by default.**
- **Ad-hoc:** `./backup.sh --tenant acme-coop`

Per-tenant dumps are the right design for schema-per-tenant: the blast radius of
a restore matches the blast radius of the incident.

**restore.sh** — the inverse, and it takes the same view of what a backup is.
It restores the dumps _and_ the uploads archive, into a target that must be
named explicitly:

```bash
./restore.sh --target smart_loan_drill --create --uploads-dir /tmp/u \
  20260812T023000-full.sql.gz 20260812T023000-uploads.tar.gz
```

The target is never inherited from `DATABASE_URL`. The failure that guards
against is restoring last night's dump over a live database at 3am because the
shell had the production URL exported; the dumps carry `DROP TABLE`, so that
mistake is not recoverable by noticing quickly. Two independent checks, because
either can be defeated alone:

1. **Textual** — `host:port/dbname` on both sides. Works with the live database
   unreachable, which is the state you are actually in during a disaster.
2. **Cluster fingerprint** — `current_database()` + `pg_postmaster_start_time()`.
   Catches the same database spelled two ways. In testing, a target of
   `postgres://…@127.0.0.1:5433/smart_loan` sailed past the textual check and
   was stopped by this one.

`--force` overrides both and is the documented way to perform a genuine
production restore. The same rule applies to `--uploads-dir` against the
configured `UPLOADS_DIR`.

**drill.sh** — the whole drill as one command; see below.

## Coverage against §69

| Requirement                  | Status                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database backup              | **EXISTS**                                                                                                                                                                                                                                   |
| Tenant backup                | **EXISTS** — per-schema dumps. **Restore path untested** — the drill ran single-tenant; see "What the drill did not prove".                                                                                                                  |
| Restore procedure            | **EXISTS** — `restore.sh`, now covering uploads and refusing to overwrite the configured database                                                                                                                                            |
| **Configuration backup**     | **STILL MISSING** — `.env` is not covered by any script. Unchanged by this work, and deliberately not papered over: a restored database with the wrong `JWT_SECRET` logs nobody in.                                                          |
| **Object storage backup**    | **MITIGATED, NOT SOLVED** — uploads are on the container filesystem, outside the database dump. `backup.sh` now tars `UPLOADS_DIR` and `restore.sh` restores it, and the drill verifies the manifest. The structural fix (S3/MinIO) remains. |
| **Restore verification**     | **EXISTS** — `libs/db/scripts/verify-restore.mjs`                                                                                                                                                                                            |
| **Documented restore drill** | **EXISTS** — `deploy/backup/drill.sh`, run 12 Aug 2026, results below                                                                                                                                                                        |

## Uploaded files — closed, but only if configured

Until 11 Aug 2026 `backup.sh` dumped Postgres and nothing else. Files live on
the API container, so a restore produced a database referencing KYC documents,
signed loan agreements and collateral photographs that no longer existed: every
row intact, every file gone.

`backup.sh` now archives `UPLOADS_DIR` into `${TS}-uploads.tar.gz` alongside the
dumps, promotes it to `weekly/` on Sundays, ships it in the offsite sync and
rotates it on the same schedule.

Half of that was still open until 12 Aug 2026: `restore.sh` handled `*.sql.gz`
only, so the files were being backed up and then not restored. It now takes the
uploads archive and a `--uploads-dir`, and the drill checks the restored tree
against a manifest digest rather than assuming `tar` did its job.

**Two things to know:**

1. **`UPLOADS_DIR` is unset by default.** An existing deployment gets no upload
   backup until it is configured. Set it to whatever `config.uploadsDir`
   resolves to for that host.
2. **A configured-but-missing directory logs loudly and continues.** A wrong
   path is far more likely than a deliberate absence, and a backup that
   silently skips the files is worse than one that complains.

Leave it unset once uploads move to object storage — S3/MinIO has its own
replication and does not want a nightly tar of the same bytes. That remains the
structural fix (roadmap 3.1); this is the mitigation that stops the bleeding
now.

## The restore drill

`deploy/backup/drill.sh`. One command, and the whole of it:

```bash
DATABASE_URL=postgresql://app:pw@db/production \
UPLOADS_DIR=/srv/smart-loan/uploads \
  bash deploy/backup/drill.sh
```

1. **Baseline** from the source — row counts for every table, the five
   reconciliation checks, and a manifest of the uploads tree. Before the backup,
   not after: the baseline is the answer the restore has to reproduce.
2. **Backup** with the real `backup.sh`. A drill that exercises a different code
   path than the nightly cron proves nothing about the nightly cron.
3. **Restore** into a throwaway `smart_loan_drill` database with `restore.sh`,
   dumps and uploads together. `drill.sh` never passes `--force`, so if the
   scratch name ever resolves to the source the drill fails instead of
   overwriting what it just dumped.
4. **Migration status** — `prisma migrate status` against the restored database.
   The dump carries `_prisma_migrations`, so a mismatch means the dump predates
   a migration and the application code would fail against it.
5. **Verify** — `libs/db/scripts/verify-restore.mjs`, which is the step that
   makes this a drill rather than a copy.

### What "verified" means

Three things must all agree, and the restore is verified only if
`runReconciliation` returns ok:

- **Row counts, per table.** The 31 financial tables are hard failures.
  Everything else is reported as drift, because `RefreshToken`, `AuditEvent`,
  `JobRun` and `Notification` are written by the running system between the
  baseline and the dump — failing on those would make the drill fail for reasons
  that have nothing to do with the backup, and a drill that cries wolf is a
  drill that gets skipped. The count query is generic (`query_to_xml` over
  `pg_class`), so the table the next migration adds is covered without anyone
  remembering to add it.
- **Reconciliation**, re-run against the _restored_ database — the five checks
  in `libs/db/src/lib/reconciliation.ts`, not new SQL. Counts prove the rows
  arrived; reconciliation proves they still mean something. A dump restored with
  a truncated `JournalLine` has the trial balance out by the missing side, and
  no count of `JournalEntry` alone would see it.
- **Uploads** — file count, total bytes and a SHA-256 over the sorted
  `path:size` manifest. The database holds paths, not documents.

### Run of 12 Aug 2026

Source: the dev database (Postgres 16.14, single-tenant, 74 tables, 1,257 rows,
trial balance ₱1,485,103.64, Loans Receivable ₱227,181.78) and an uploads tree
of 13 files / 198,476 bytes.

```
  Row counts
    ok   every financial table matches (31 checked, 74 tables total)

  Reconciliation on the RESTORED database
    ok   trial_balance: Trial balance ties at 1485103.64.
    ok   entry_balance: Every journal entry balances.
    ok   duplicate_source_refs: No duplicate auto-posted entries.
    ok   schedule_bounds: Every instalment's progress is within its due amounts.
    ok   receivable_subledger: Loans Receivable agrees with the loan book at 227181.78.

  Uploads
    ok   13 file(s), 198476 bytes

  VERIFIED — the restored database holds the same book as the source.
```

`prisma migrate status` reported **"Database schema is up to date!"** against the
restored database — all 71 migrations present.

### Re-run on an unpatched host — it FAILS, and that is the point

The run above needed a PostgreSQL 16 `pg_dump` put on `PATH` by hand, because
this workstation ships the 18.4 client tools against a 16.14 server. Re-run
**without** that workaround — i.e. the host exactly as provisioned — and the
drill does this:

```
!! pg_dump is 18.x but the server is 16.x
!! a dump from a NEWER client may not replay into a 16.x server
...
ERROR:  unrecognized configuration parameter "transaction_timeout"
[..] dropping scratch database smart_loan_drill
exit 3
```

Independently reproduced 12 Aug 2026. Source database untouched afterwards
(79 `JournalLine` rows, unchanged); scratch database dropped; nothing leaked.

**Read that as the headline result, not a footnote.** On a host with skewed
client tools the nightly backup produces files that cannot be restored, and
before this drill existed nothing anywhere would have told you — `backup.sh`
exited 0, the `.sql.gz` was the right size, and the old `restore.sh` would have
reported success while restoring nothing. The drill is doing exactly the job
§69 asks of it: it turned a backup nobody had tested into a known-bad backup
with a named cause.

The fix is provisioning, not code: install client tools matching the server's
major version. `backup.sh` now warns when they differ, and the warning fires
before the dump rather than after.

One gap in the unshimmed re-run: `UPLOADS_DIR` was empty, so it printed
`!! no uploads tree — the drill will NOT prove files survive` and skipped that
check. The file-survival evidence above comes from the shimmed run against a
synthesised tree. No real uploaded document has been through a restore.

### What the drill found

Four problems, three of them in code that was already committed. None would have
surfaced without running it, which is the entire argument for running it.

1. **The dump would not restore at all.** `pg_dump` 18.4 dumping a 16.14 server
   writes `SET transaction_timeout = 0;` into the header — a GUC that did not
   exist before Postgres 17. The dump completed, the file looked right, gzip was
   happy, and every attempt to replay it into the 16.x server died on line 9
   with `ERROR: unrecognized configuration parameter "transaction_timeout"`.
   `backup.sh` now compares client and server majors and says so loudly; the
   README's "client tools matching the server's major version" turns out to be
   load-bearing rather than tidy advice. Warning, not hard failure — a dump
   taken with a mismatched client still beats no dump, and refusing would take
   out a nightly job over a packaging untidiness.

2. **The old `restore.sh` would have called that a success.** It piped the dump
   into bare `psql`, and `psql` without `ON_ERROR_STOP=1` reports every error and
   still exits 0. A truncated or version-skewed dump restored "successfully";
   the problem surfaces months later as missing rows. `restore.sh` now sets it,
   and that flag is what caught finding 1.

3. **The old `restore.sh` restored no files.** It handled `*.sql.gz` only, so a
   restore produced a database referencing KYC documents, signed agreements and
   collateral photographs that were not there — the exact failure `backup.sh`'s
   uploads archive was added on 11 Aug to prevent, still open on the restore
   side. It now takes `*-uploads.tar.gz` and `--uploads-dir`.

4. **The first version of `drill.sh` reproduced finding 3 inside the thing meant
   to catch it.** It globbed the dumps and passed only those to `restore.sh`, so
   the first green-ish run restored zero files while reporting success. Fixed by
   passing both archive lists; it is worth recording because it is the same
   mistake twice, in the same afternoon, by someone who had just written the
   fix for it.

### The verification is not a rubber stamp

Deliberately damaged the restored database — deleted 4 of 79 `JournalLine` rows
and 2 of 13 uploaded files — and re-ran the verification. Exit code 1:

```
  Row counts
    FAIL JournalLine: baseline 79 → restored 75
    FAIL uploads: baseline 13 file(s) / 198476 bytes → restored 11 file(s) / 178546 bytes
  Reconciliation on the RESTORED database
    FAIL trial_balance: TRIAL BALANCE OUT BY 1951.12 (debits 1480375.66, credits 1478424.54).
    FAIL entry_balance: 4 journal entries do not balance.
    FAIL receivable_subledger: LOANS RECEIVABLE OUT BY 4282.28 …
  NOT VERIFIED — do not treat this backup as a working backup.
```

Four rows out of 1,257 — 0.3% of the database — trip three of the five checks.

### What the drill did **not** prove

Recorded so nobody reads a green run as more than it is:

- **The multi-tenant restore path is untested.** The source had zero tenants, so
  the drill exercised `*-full.sql.gz` only. `restore.sh` recognises
  `*-platform.sql.gz` and `*-tenant-X.sql.gz` and the code path is shared, but
  "recognises the filename" is not "has been restored". Run the drill against a
  multi-tenant deployment before relying on a per-tenant restore.
- **No real uploaded document was opened.** The environment had no uploads
  directory at all, so the tree was synthesised to match `store.ts`'s layout
  (`kyc/`, `selfies/`, `collateral/`, `signatures/`, `branding/`, UUID
  filenames). Byte-for-byte survival is proven by the manifest digest; "a KYC
  document opens in the app" is not.
- **Verification needs the repo.** It imports `reconciliation.ts`, so it needs a
  checkout with dependencies installed. A backup host carrying only `psql` can
  restore but cannot verify.
- **This was a dev-sized database.** 1,257 rows and a 103 KB dump. The timings
  below are floor values; they say the machinery works, not how long production
  takes. Re-measure on production volumes.
- **`.env` is still not backed up.** A verified database restore with the wrong
  `JWT_SECRET` logs nobody in.

### Re-run

Quarterly, and after any change to the schema-per-tenant machinery, the uploads
layout, or the Postgres major version on either side.

## RPO / RTO

**RTO — measured, at dev volumes.** Four drill runs, restore start to verified:

| Phase                      | Run 1 | Run 2 | Run 3 | Run 4 |
| -------------------------- | ----- | ----- | ----- | ----- |
| backup (dump + tar)        | 4s    | 5s    | 4s    | 12s   |
| restore (create + replay)  | 18s   | 21s   | 20s   | 28s   |
| verify                     | 6s    | 6s    | 7s    | 8s    |
| **RTO — restore→verified** | 32s   | 34s   | 35s   | 45s   |
| total incl. baseline       | 42s   | 45s   | 46s   | 65s   |

Run 2 restored over the previous run's non-empty scratch database, which is the
idempotence claim tested rather than asserted. Run 4 shared the machine with a
full `nx typecheck`; it stays in the table because "the restore takes longer
when the host is busy" is exactly the condition a real incident supplies, and
dropping the slow sample would flatter the number.

Note how little of that is the dump replay: `restore.sh` itself logged 7–9s of
the 18–28s. The rest is `CREATE DATABASE` and three short `psql` probe
connections for the safety guards. That ratio inverts at production volumes, but
it is worth knowing the guards are not free.

That 32–45s is the **data layer only**. It excludes deciding to restore,
locating the right dump, pulling it from S3 and restarting the API — the parts
that dominate a real incident and that this drill does not touch. Treat the
end-to-end RTO as unmeasured; what is now measured is that the data comes back,
correct, in well under a minute at this size.

**RPO — still a business decision, still unmade.** With nightly backups the
implied RPO is **up to 24 hours of lost financial transactions**, inherited from
a cron schedule rather than chosen. If that is unacceptable the options are WAL
archiving / PITR or more frequent dumps — a conversation to have before an
incident, not during one. The drill does not change this number; it only means
that whatever is in the nightly dump now demonstrably comes back.

## Related runbooks

`docs/runbooks.md` covers operational incidents: tenant stuck provisioning,
scheduler not firing, license state, `MissingTenantClaim` after cutover,
connection-pool exhaustion, DSAR handling, and vendor support sessions. Those
are complementary — they handle degradation; this document handles loss.
