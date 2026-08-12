# Database Audit

Measured: **3,373 lines** of schema, **71 models**, **52 enums**, **65 migrations**,
**48 unique constraints**, **0** Decimal fields lacking explicit precision.

## Money typing — pass

Detailed in `repository-audit.md` §C: 79 `Decimal` columns all with explicit
precision, 5 `Float` columns none of which are monetary. The brief's §11
requires no work. This is the finding most worth stating plainly, because it is
the defect that usually forces a painful migration and it simply is not here.

## Multi-tenancy — keep it

Schema-per-tenant (`CREATE SCHEMA "tenant_<slug>"`):

- `libs/db/src/lib/multi-tenant-migrate.ts` — schema creation and migration fan-out
- `libs/db/src/multi-tenant-plugin.ts` — per-request resolution and client binding
- `libs/db/src/tenant-cache.ts` — client reuse
- `libs/db/src/lib/adopt-existing.ts` — absorbing a pre-existing database
- `apps/api/src/features/tenancy/tenant-isolation.test.ts` — a real isolation test

Row-level tenancy would be a **downgrade**: schema separation makes a leak a
deployment error rather than a forgotten `WHERE` clause, and there is a test
guarding it. Do not change this.

**Standing constraint:** every migration must fan out across all tenant schemas.
The machinery exists and is tested (`multi-tenant-migrate.test.ts`); the
discipline is to verify each new migration against the public schema _and_ at
least one tenant schema before release.

## Referential integrity — one live hazard

Delete rules are deliberately mixed, but the mix is what made customer deletion
dangerous (resolved at the application layer by archiving, commit `3a9d0fa`):

| Relation                              | Rule                | Consequence if a Customer were deleted       |
| ------------------------------------- | ------------------- | -------------------------------------------- |
| `LoanApplication.customer`            | RESTRICT            | refused — correct                            |
| `CoMaker.customer`                    | RESTRICT            | refused — correct                            |
| `Contribution.customer`               | **CASCADE**         | silently deletes coop capital records        |
| `SavingsTransaction.customer`         | **CASCADE**         | silently deletes savings movements           |
| `FundTransaction/Withdrawal.customer` | SetNull             | money kept, attribution lost                 |
| `AuditEvent.actor`                    | RESTRICT (required) | a user who ever acted cannot be hard-deleted |

**D-1 (P1):** the two CASCADE rules remain a latent hazard. The service layer now
refuses to delete customers at all, but the schema still permits it, so any
future code path or manual `DELETE` re-opens the hole. Change both to RESTRICT so
the database enforces what the service promises. Requires confirming no seed or
test path depends on the cascade.

## Indexing

Indexes exist on the paths inspected: `entryDate`, `periodId`,
`(source, sourceRefId)`, `(sourceRefType, sourceRefId)`, `(actorId, createdAt desc)`,
`erasedAt`, `archivedAt`, `phone`, `(governmentIdType, governmentIdNumber)`,
`refreshToken.userId`, `expiresAt`.

**D-2 (P2):** no query-plan evidence exists. The brief (§59) is right that
`EXPLAIN` should precede bulk index additions. Capture plans for the ten slowest
endpoints at realistic row counts, then index from evidence.

## Migration tooling note

65 hand-written migrations applied via `pnpm --filter @loan/db exec dotenv -e ../../.env -- prisma migrate deploy`.

Running a bare `npx prisma validate` at the repo root fails with a **Prisma 7**
CLI error (`datasource url no longer supported in schema files`). The repo pins
Prisma **6.19.3** and drives migrations through the `libs/db` scripts, so this is
a CLI-version mismatch when a stray Prisma 7 is resolved — not a schema defect.
**D-3 (P3):** pin the CLI invocation in CI so this cannot surface as a confusing
red build.
