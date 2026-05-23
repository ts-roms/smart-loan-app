# Multi-tenant cutover checklist

The Phase 2 refactor (P2.1 → P2.11) is functionally complete: every
authenticated tenant-facing route reads + writes through
`req.tenantCtx.prisma`, the cross-cutting providers are exposed as
per-tenant factory decorators, and the background scheduler fans out
across active tenants on each tick.

`MULTI_TENANT=true` is **not yet the default** because flipping it is a
deployment decision, not a code decision. This document is the operator
checklist that gates that flip.

## §1 — Code-level gates (already in CI)

| Check                                                   | Status                 | Where                                                    |
| ------------------------------------------------------- | ---------------------- | -------------------------------------------------------- |
| Every feature route uses `req.tenantCtx.prisma`         | ✓ (typecheck enforces) | `apps/api/src/features/**`                               |
| `app.notifications` / `app.screening` are factories     | ✓ (typecheck enforces) | `apps/api/src/routes/index.ts`                           |
| `TenantPrismaCache` builds DSNs with `?schema=tenant_…` | ✓ (unit test)          | `apps/api/src/features/tenancy/tenant-isolation.test.ts` |
| `resolveTenant` rejects bad slugs                       | ✓ (unit test)          | same file                                                |
| Scheduler fans out across tenants                       | ✓ (review the type)    | `libs/db/src/tenant-scheduler.ts`                        |
| All API tests pass                                      | ✓                      | `pnpm --filter @loan/api test`                           |

Nothing else here can be automated cheaply — the rest is operational
verification on a real Postgres.

## §2 — Pre-flight environment check

Before flipping `MULTI_TENANT=true`, confirm the following are in place
in the target environment:

1. **`DATABASE_URL` reaches Postgres with CREATE SCHEMA permission.**
   `TenantPrismaCache` doesn't create schemas — it just connects with
   `?schema=tenant_<slug>`. The migration runner (P2.2) creates the
   schema during `provisionTenant`. If the connecting role can't
   `CREATE SCHEMA`, provisioning fails at request time.

2. **At least one tenant exists in `public.Tenant` with status `ACTIVE`.**
   Without one, every authenticated request 401s with `MissingTenantClaim`.
   For an existing single-tenant deploy, run the one-shot adoption
   script — see §2.B below for the full walkthrough.

3. **The platform console (`/platform/*`) is reachable** and at least
   one `PlatformUser` exists. Without it you can't provision new
   tenants once the flag is on — the only path to creating tenants is
   the platform API.

4. **Connection-pool budget.** Default is 3 connections per tenant. At
   50 tenants × 3 = 150 max. Set `connection_limit` lower (via the
   `MultiTenantPluginOptions.perTenantConnectionLimit`) if your DB
   instance is sized smaller.

## §2.B — Adopting an existing single-tenant deploy

If you're flipping the flag on a database that already has real data
in `public` (i.e. the deploy has been running as single-tenant), you
need to move that data into a `tenant_<slug>` schema first. The
`adopt-existing-as-tenant` CLI does this atomically.

```bash
pnpm --filter @loan/db adopt-existing-as-tenant \
  --slug acme-coop \
  --name "Acme Cooperative" \
  --platform-admin-email ops@vendor.com \
  --platform-admin-name "Vendor Ops" \
  --confirm-slug acme-coop
```

What it does, in order:

1. **Pre-flight checks** — target schema doesn't already exist; public
   has data; `public.Tenant` is still empty (i.e. multi-tenant hasn't
   started). If any of those fail, the script refuses to run.
2. **`pg_dump` backup** to `./backups/<timestamp>-pre-adopt-<slug>.sql`.
   The path is printed in the output — archive it before continuing.
   Pass `--skip-backup` to skip if you have an external pipeline.
3. **Schema rename**: `ALTER SCHEMA public RENAME TO tenant_<slug>` +
   `CREATE SCHEMA public`, in a single transaction.
4. **`prisma migrate deploy`** against the fresh `public` schema —
   recreates the platform tables and the (empty) tenant tables. The
   empty tenant tables in `public` are dead-weight in multi-tenant
   mode; the same asymmetry exists in every tenant schema from the
   other direction (each tenant schema also has dead-weight Tenant /
   PlatformUser tables that the system never reads from).
5. **`prisma migrate deploy`** against `tenant_<slug>` too — idempotent;
   catches the case where the previous deploy hadn't pulled the newest
   migrations.
6. **Bootstrap rows**: inserts the `Tenant` row for the adopted slug
   and a `PlatformUser` (PLATFORM_ADMIN) with the email + name you
   supplied. A temp password is generated and printed to the CLI
   **once** — copy it somewhere safe immediately.

After the script succeeds:

- Set `MULTI_TENANT=true` in `.env` and restart the API.
- Log into the platform console at `/platform/login` with the
  `platform-admin-email` + temp password; change the password right
  away.
- Existing tenant users keep their credentials but now sign in via
  `/login?tenant=<slug>` (the tenant-scoped login flow added in P2.3).
- Verify by logging in as one of those tenant users and confirming
  their data is intact.

Recovery: if anything goes wrong after step 3 (rename committed but
prisma migrate failed), restore from the backup file printed by the
script:

```bash
psql $DATABASE_URL -c 'DROP SCHEMA tenant_acme-coop CASCADE; CREATE SCHEMA public;'
psql $DATABASE_URL < ./backups/<timestamp>-pre-adopt-acme-coop.sql
```

The unit tests in `libs/db/src/lib/adopt-existing.test.ts` cover the
pre-flight gates; the rename + migrate happens against live Postgres
so end-to-end testing of those steps lives in the smoke below.

## §3 — Manual cross-tenant isolation smoke

Run once before the cutover and once again right after, against the
target environment. This is the smoke that proves Postgres physically
enforces the boundary; the unit tests only prove the wiring sends the
right `schema` parameter.

```bash
# (1) Provision two tenants via the platform console
curl -X POST $API/platform/tenants \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug": "isolation-a", "name": "Test A"}'
curl -X POST $API/platform/tenants \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug": "isolation-b", "name": "Test B"}'

# (2) Create an admin user in each via the bootstrap endpoint
# (each tenant gets its own seed admin per the seed-tenant helper)

# (3) Log in as tenant A's admin, save the JWT
curl -X POST $API/auth/login \
  -d '{"tenantSlug": "isolation-a", "email": "...", "password": "..."}'

# (4) Create a customer in tenant A
TENANT_A_CUSTOMER_ID=$(curl -X POST $API/customers \
  -H "Authorization: Bearer $TOKEN_A" \
  -d '{...}' | jq -r .id)

# (5) Log in as tenant B's admin
curl -X POST $API/auth/login \
  -d '{"tenantSlug": "isolation-b", "email": "...", "password": "..."}'

# (6) Try to read tenant A's customer with tenant B's token
curl -i $API/customers/$TENANT_A_CUSTOMER_ID \
  -H "Authorization: Bearer $TOKEN_B"
# EXPECTED: 404 Not Found (because tenant B's prisma points at
# tenant_isolation-b which never had that row inserted)

# (7) For a stronger proof: connect directly with psql and confirm
psql "$DATABASE_URL" -c "SET search_path = tenant_isolation_b, public; \
  SELECT count(*) FROM \"Customer\";"
# EXPECTED: 0 (or whatever tenant B's count is — not A's)

# (8) Cleanup: archive both test tenants
```

The cutover is gated on §3 passing — if step (6) returns 200 with
tenant A's data visible, do not flip the flag.

## §4 — Flipping the flag

In `.env` (production):

```diff
- MULTI_TENANT=false
+ MULTI_TENANT=true
```

Then restart the API. The startup log line `multi-tenant mode: on`
(from `fastifyTenantPrisma`) confirms the mode.

If anything goes wrong, flipping back to `false` is safe — existing
clients with tenant-scoped JWTs will keep working (the resolve
preHandler still honors the `tenant` claim when `multiTenant=false`,
falling through to `app.prisma`), they just won't get schema
isolation. Re-rolling tokens isn't required to revert.

## §5 — Post-cutover monitoring

For the first 24h after the flip, watch:

- **Per-tenant connection counts.** `SELECT datname, usename, count(*)
FROM pg_stat_activity GROUP BY 1,2;` — should show each tenant slug
  showing up as the application_name, with at most `connection_limit`
  active connections per slug.
- **Scheduler ticks per tenant.** The `TenantScheduler` logs a warn
  on per-tenant tick failure. If a tenant 503s the platform's
  `findMany`, it'll get skipped without affecting others.
- **`/api/v1/jobs` per tenant.** Admin users in each tenant should
  see jobs registered + last-run timestamps; if not, the per-tenant
  `register()` failed at first tick — most often because the tenant
  schema isn't fully migrated.

## §6 — Operational tooling shipped after P2.11

Three operational features land alongside the cutover:

- **`adopt-existing-as-tenant` CLI** — §2.B. Moves a single-tenant
  deploy's existing data into a `tenant_<slug>` schema atomically,
  with a `pg_dump` backup taken before the rename. Source:
  `libs/db/src/lib/adopt-existing.ts`.
- **`POST /platform/tenants/:slug/impersonate`** — vendor support
  staff (PLATFORM_ADMIN only) can mint a short-lived tenant-side JWT
  to log into a customer's installation without asking for
  credentials. Token TTL is capped at 60 minutes; every issuance is
  audit-logged on both platform and tenant sides. Payload carries the
  `impersonatedBy` claim so downstream audit code can attribute
  actions to both the tenant user and the vendor staff. Source:
  `apps/api/src/features/platform/platform.service.ts` →
  `impersonateTenant`.
- **`TenantScheduler`** (P2.11) — per-tenant fan-out of background
  jobs. Source: `libs/db/src/tenant-scheduler.ts`.

## §7 — Carry-overs not in scope

These are honest about what would still need work, not just hand-waves:

- **Per-tenant provider credentials.** Provider singletons (Twilio,
  SendGrid, AML clients) are shared across tenants. Sending SMS for
  tenant A still goes through the one Twilio account configured in
  `.env`. Reworking this would require either per-tenant credential
  storage in `SystemConfig` (each tenant's own keys, decrypted at
  request time) or a vendor-owned upstream account billed back to
  the tenant. Pricing decision before code decision.

- **`public.JobRun` / `public.ScheduledJob` tables in multi-tenant
  mode.** All job activity writes to `tenant_<slug>` schemas. The
  copies in `public` are dead-weight. They cannot be dropped without
  Prisma's `multiSchema` preview feature (a single Prisma schema
  can't say "this model only lives in tenant schemas, not public").
  Operators concerned about cleanliness can `DROP TABLE` them
  manually, but `prisma migrate deploy` will recreate them empty on
  next deploy. Documented quirk, not a leak.

- **`impersonatedBy` audit propagation.** The platform mints a token
  with the claim; the tenant side records `PLATFORM_IMPERSONATION_STARTED`
  once. But every subsequent audited action during the impersonated
  session is attributed only to the tenant user (`actorId = target.id`).
  Threading `req.user.impersonatedBy` into every `audit.record()`
  call so the trail says "X did Y (impersonated by VENDOR_OPS)"
  is a follow-up sweep across all feature services.

- **Cross-tenant platform views.** The platform console can list
  tenants (from `public.Tenant`) and per-tenant licenses, but can't
  drill into a tenant's customers / loans without using impersonate.
  Cross-tenant reporting (e.g. "total AUM across all tenants") would
  need a read-only platform-side aggregator that fans out across
  tenant schemas. Out of P2 scope.
