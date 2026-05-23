# Operator runbooks

Short, prescriptive SOPs for the most likely incidents. Each runbook
follows the same shape: **what you'd see**, **first check**, **fix**,
**postmortem**. If a runbook says "see code at X" — open X, don't
improvise from memory.

## R1 — Tenant stuck in `PROVISIONING`

**What you'd see.** A `Tenant` row was created (POST /platform/tenants
returned 201) but `status` hasn't flipped to `ACTIVE` after a couple
of minutes. The platform console shows a yellow "provisioning" badge.
Users for that tenant get `503 TenantProvisioning` on every request.

**First check.** Look at `Tenant.provisioningError`:

```sql
SELECT slug, status, "provisioningError", "createdAt"
FROM public."Tenant" WHERE status = 'PROVISIONING';
```

If `provisioningError` is non-null, that's the actual failure
(usually a `prisma migrate deploy` error: missing privilege, bad
DATABASE_URL, schema already exists).

**Fix.**

1. Resolve the underlying cause (grant CREATE SCHEMA, fix DATABASE_URL,
   manually drop the leftover schema, etc.).
2. Retry from the platform console UI ("Retry provisioning" button),
   or via API:
   ```
   POST /platform/tenants/<slug>/retry-provisioning
   ```
   The retry endpoint reuses `provisionTenant` from where it left off
   and clears `provisioningError` on success.

If the schema partially exists (the rename + create transaction
landed but migrations didn't), you can either:

- Re-run with `--create-schema-if-missing` via the `migrate-tenants`
  CLI:
  ```
  pnpm --filter @loan/db migrate-tenants --only <slug> \
       --create-schema-if-missing --force
  ```
- Or drop the half-built schema and let `retry-provisioning` start fresh:
  ```sql
  DROP SCHEMA tenant_<slug> CASCADE;
  ```
  Then hit the retry endpoint.

**Postmortem.** If this fired because of a privilege issue, fix the
`.env` documentation. If `prisma migrate deploy` hung, look at the
spawn timeout in `libs/db/src/lib/multi-tenant-migrate.ts` — it's 5
min by default but configurable.

---

## R2 — `TenantScheduler` not firing for one tenant

**What you'd see.** Tenant A's nightly jobs (late-fee accrual, reminder
emails) didn't run. Other tenants' jobs ran fine. `pg_stat_activity`
shows no `pg_dump`-style long queries for tenant A.

**First check.** Search the API logs for the slug:

```bash
journalctl -u smart-loan-api | grep -i "tenant.*acme-coop"
```

Look specifically for `"TenantScheduler: failed to register jobs for tenant"`
or `"TenantScheduler tenant tick failed"` — the scheduler logs a warn
on each per-tenant failure but keeps fanning out across the rest.

**Fix.**

- **`failed to register jobs`** — the tenant schema isn't fully migrated.
  Force a migration:

  ```
  pnpm --filter @loan/db migrate-tenants --only <slug>
  ```

  Then on the next tick (≤60s) the scheduler will retry registration
  and start running jobs.

- **`tenant tick failed`** — a job's body threw. Find the specific
  failure in the tenant's `JobRun` table:
  ```sql
  -- connected to the platform DB, but querying tenant_<slug>.JobRun:
  SET search_path = "tenant_acme-coop", public;
  SELECT j.name, r."startedAt", r.status, r.error
  FROM "JobRun" r
  JOIN "ScheduledJob" j ON j.id = r."jobId"
  WHERE r.status = 'FAILED'
  ORDER BY r."startedAt" DESC LIMIT 10;
  ```
  Fix the underlying data, then trigger a manual re-run via the admin
  console ("Run now" on the failed job).

**Postmortem.** If a single job in one tenant's schema repeatedly
breaks the tick for that tenant, isolation in `TenantScheduler.tickTenant`
is what saves the other tenants. If MULTIPLE tenants fail, suspect
the shared provider (Twilio outage, AML rate-limit) rather than
per-tenant data.

---

## R3 — License "EXPIRED" on the dashboard but you just renewed

**What you'd see.** Tenant operator says they activated a fresh license
token, but the dashboard banner still says EXPIRED. `GET /license/status`
returns `status: "EXPIRED"`.

**First check.** Run the status endpoint with `kind` exposed:

```
GET /api/v1/license/status
```

If `kind === "NoKeyConfigured"`, the API host doesn't have
`LICENSE_PUBLIC_KEY_PEM` (or `LICENSE_PUBLIC_KEY_PATH`) set — every
license verification fails, regardless of whether the token is fresh.

If `kind === "Tampered"`, the token was edited (whitespace pasted in,
quotes added, etc.) — get a fresh copy.

If `kind === "Expired"`, the token's `exp` field is in the past. Mint
a new one from the platform console.

**Fix.**

- **`NoKeyConfigured`:** Add `LICENSE_PUBLIC_KEY_PEM` to the API's
  `.env`, restart the API. The public key is in the platform console
  (Settings → License Keys) or `deploy/licensing/public.pem` if you
  followed the bootstrap docs.
- **`Tampered`:** From the platform console, **Tenants → <slug> →
  Licenses → resend**. The full token is stored on `PlatformIssuedLicense.token`;
  resending is idempotent (same JTI).
- **`Expired`:** From the platform console, **Tenants → <slug> →
  Issue license**, set the new expiry, send the token to the tenant.
  Their existing `/license/activate` endpoint accepts the upgrade
  without manual deactivation (upsert on JTI).

**Postmortem.** Public-key resolution happens once at plugin
registration; restart is required for env changes. If you're rotating
the platform private key, the tenant public key has to change too —
plan a coordinated upgrade.

---

## R4 — `MissingTenantClaim` 401s on every request after the cutover

**What you'd see.** Right after flipping `MULTI_TENANT=true`, all API
requests return 401 with `{ error: "MissingTenantClaim" }`. Health
checks (`/health/live`) still work.

**First check.** Decode one of the rejected JWTs (paste into jwt.io)
and look for the `tenant` claim. If it's missing, the token was minted
before P2.3 added the claim — i.e. the user logged in pre-cutover
and the SPA still has the old token in localStorage.

**Fix.** Force a re-login. Three options, increasing severity:

1. **Soft:** Tell the tenant admin to log out + log back in. New
   tokens carry the claim.
2. **Medium:** Revoke all RefreshTokens for the tenant via direct SQL:
   ```sql
   SET search_path = "tenant_acme-coop", public;
   UPDATE "RefreshToken" SET "revokedAt" = NOW() WHERE "revokedAt" IS NULL;
   ```
   Forces every user in that tenant back to /login on the next refresh.
3. **Hard:** Rotate `JWT_SECRET`. Invalidates everyone's tokens
   globally — only use if you suspect a token compromise, not for
   the cutover case.

**Postmortem.** P2.3c added the optional `tenantSlug` to the SPA login
flow; verify that the deploy includes the post-P2.3 web bundle. If
not, the SPA won't pass the slug along on login and tokens stay
slugless.

---

## R5 — Sudden Postgres connection pool exhaustion

**What you'd see.** API logs full of `"Timed out fetching a connection
from the pool"` errors. `pg_stat_activity` shows hundreds of idle
sessions.

**First check.** Count connections per tenant:

```sql
SELECT application_name, count(*)
FROM pg_stat_activity
WHERE datname = '<your db>'
GROUP BY 1 ORDER BY 2 DESC;
```

If one tenant dominates (say 30+ connections), they've spawned more
than the `per_tenant_connection_limit` allows — usually because
something inside that tenant is holding connections (long-running
report query, stuck migration).

**Fix.**

- **Short-term:** kill the offending sessions:
  ```sql
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE application_name LIKE 'tenant_acme%' AND state = 'idle in transaction';
  ```
- **Medium-term:** lower `PER_TENANT_CONNECTION_LIMIT` in the API's
  `.env`. Default is 3; if you have 100 tenants on a small DB that
  gives 300 max — could be too high.
- **Long-term:** put a pgBouncer in front of Postgres with
  `pool_mode = transaction`. The TenantPrismaCache holds N Prisma
  clients × M per-tenant; pgBouncer multiplexes them onto a smaller
  underlying pool.

**Postmortem.** Long-running transactions inside a tenant's request
are the usual culprit. Check for missing `await`s or queries without
`take:` that scan large tables.

---

## R6 — Vendor support session ("can you check tenant X for me?")

The internal flow when a tenant asks for live debugging help:

1. Tenant admin opens a support ticket explicitly inviting vendor
   access. **Do not impersonate without a ticket** — the audit trail
   needs the explanation to be tied to a customer-facing record.
2. From the platform console (or via API), mint an impersonation
   token:
   ```
   POST /platform/tenants/<slug>/impersonate
   { "purpose": "Customer ticket #1234 — investigating duplicate journal entries",
     "expiresInMin": 30,
     "targetUserEmail": "admin@<slug>.local"   // optional
   }
   ```
3. Open `/login` in a private/incognito browser tab. Paste the token
   into localStorage under the `accessToken` key (the web app reads
   it from there). Or use a custom redirect URL the platform console
   provides (`/impersonate?token=<token>`).
4. Do the debugging. Every action you take is audit-logged in the
   tenant's audit log as **the tenant user**, NOT as you — until
   the audit-propagation follow-up lands. The tenant admin can see
   `PLATFORM_IMPERSONATION_STARTED` in their audit, with your email
   on it.
5. Close the tab when done. The token expires automatically; no
   "log out" required.

If you need longer than 60 minutes, mint another token rather than
extending. Each issuance is its own audit row, which is what an
auditor expects.
