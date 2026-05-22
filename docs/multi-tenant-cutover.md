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
   For an existing single-tenant deploy, run the "adopt-existing"
   migration (manual, one-time):

   ```sql
   INSERT INTO public."Tenant"
     (slug, name, status, "createdAt", "updatedAt")
     VALUES ('default', 'Legacy', 'ACTIVE', NOW(), NOW());
   ```

   Then move the legacy `public` data into `tenant_default` via the
   schema-rename script (see `docs/multi-tenant-implementation.md §7`).

3. **The platform console (`/platform/*`) is reachable** and at least
   one `PlatformUser` exists. Without it you can't provision new
   tenants once the flag is on — the only path to creating tenants is
   the platform API.

4. **Connection-pool budget.** Default is 3 connections per tenant. At
   50 tenants × 3 = 150 max. Set `connection_limit` lower (via the
   `MultiTenantPluginOptions.perTenantConnectionLimit`) if your DB
   instance is sized smaller.

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

## §6 — Carry-overs not in scope of P2.11

- **Provider singletons (Twilio, SendGrid, AML clients) are shared
  across tenants.** Sending SMS for tenant A still goes through the
  one Twilio account configured in `.env`. Per-tenant provider
  credentials is a separate enhancement (P3.x).
- **The platform's own `JobRun` table is unused now.** All job runs
  are recorded per-tenant. A future cleanup can drop `public.JobRun` /
  `public.ScheduledJob` since they no longer get written to.
- **Cross-tenant search / admin views.** The platform console can list
  tenants (uses `public.Tenant`) but can't drill into a tenant's
  customers without logging in as that tenant's admin. A
  "platform-impersonate-tenant" feature would change that — also
  outside Phase 2 scope.
