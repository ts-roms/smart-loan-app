# Disaster Recovery

§69. What exists, what is missing, and the drill that has not yet been run.

---

## What exists

`deploy/backup/backup.sh` and `deploy/backup/restore.sh`, with a README.

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

## Coverage against §69

| Requirement                  | Status                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database backup              | **EXISTS**                                                                                                                                                                                                                       |
| Tenant backup                | **EXISTS** — per-schema dumps                                                                                                                                                                                                    |
| Restore procedure            | **EXISTS** — `restore.sh`                                                                                                                                                                                                        |
| Configuration backup         | **PARTIAL** — `.env` is not covered by the script                                                                                                                                                                                |
| **Object storage backup**    | **NOT APPLICABLE YET, AND THAT IS THE PROBLEM** — uploads are on the container filesystem, so they are outside the database dump entirely. A database restore brings back the KYC _metadata_ and none of the _files_. See below. |
| **Restore verification**     | **MISSING**                                                                                                                                                                                                                      |
| **Documented restore drill** | **MISSING**                                                                                                                                                                                                                      |

## Uploaded files — closed, but only if configured

Until 11 Aug 2026 `backup.sh` dumped Postgres and nothing else. Files live on
the API container, so a restore produced a database referencing KYC documents,
signed loan agreements and collateral photographs that no longer existed: every
row intact, every file gone.

`backup.sh` now archives `UPLOADS_DIR` into `${TS}-uploads.tar.gz` alongside the
dumps, promotes it to `weekly/` on Sundays, ships it in the offsite sync and
rotates it on the same schedule.

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

## Restore drill — to be written and run

§69 asks for a documented drill. It does not exist. The shape it should take:

1. **Provision** a scratch environment from the same compose/deploy definition.
2. **Restore** the most recent nightly: `public` first, then one tenant schema.
3. **Verify** — and this is the part that makes it a drill rather than a
   command:
   - `prisma migrate status` reports no pending migrations
   - the trial balance ties (debits == credits) for the restored tenant
   - `detect-duplicate-journal-entries.mjs` reports clean
   - a known loan's schedule, payments and outstanding balance match the values
     recorded before the drill
   - a KYC document opens (the check that would currently fail)
4. **Record** the wall-clock time from decision to verified restore. That number
   is the real RTO; anything else is an estimate.
5. **Re-run quarterly**, and after any change to the schema-per-tenant machinery.

## RPO / RTO — not yet defined

Neither is stated anywhere in the repository. With nightly backups the implied
RPO is **up to 24 hours of lost financial transactions**, which is a business
decision that should be made explicitly rather than inherited from a cron
schedule. If that is unacceptable, the options are WAL archiving / PITR or more
frequent dumps — a conversation to have before an incident, not during one.

## Related runbooks

`docs/runbooks.md` covers operational incidents: tenant stuck provisioning,
scheduler not firing, license state, `MissingTenantClaim` after cutover,
connection-pool exhaustion, DSAR handling, and vendor support sessions. Those
are complementary — they handle degradation; this document handles loss.
