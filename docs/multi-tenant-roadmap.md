# Multi-tenancy + platform console roadmap

This document covers Phase 2 (schema-per-tenant multi-tenancy) and
Phase 3 (platform console) of the licensing/SaaS conversion. Phase 1
(license activation) is **done** and shipped — see
`apps/api/src/features/licensing/` and `libs/licensing/`.

This is the design doc + work breakdown. Every entry below is
implementable; nothing here is speculative architecture. The plan is
honest about scope: Phase 2 is ~2 weeks of focused engineering, Phase 3
is ~1-2 weeks. Doing them sloppily creates cross-tenant data leaks,
which is the worst possible bug in this app.

---

## Phase 2 — Multi-tenancy (schema-per-tenant)

### What's already in place

- `Tenant` model in `libs/db/prisma/schema.prisma`
- `tenant` migration (`20260522070000_tenant`) — table only, no
  conversion of existing data yet
- The existing single-tenant deploy continues to work; `Tenant` is
  an empty catalog until Phase 2 work lands

### Decision: schema-per-tenant (already chosen)

One Postgres instance, one schema per tenant. Domain tables (Customer,
Loan, JournalEntry, etc.) live in `tenant_<slug>` schemas. Control-
plane tables (`Tenant`, `License`) stay in `public`.

**Why not row-level**: any forgotten WHERE clause leaks data. With
schemas, the table physically doesn't exist in the wrong schema —
the SQL bug becomes a query error, not a silent breach. The
operational cost (N migrations per tenant) is manageable up to ~100
tenants, which is the realistic ceiling for this product.

**Why not database-per-tenant**: managing N Postgres databases scales
worse than N schemas. Connection pooling fragments, backups multiply,
migrations need an outer orchestrator. We can revisit if a single
regulated client demands a dedicated DB; the schema-per-tenant code
also works for that (just point each tenant at a different DATABASE_URL).

### Tenant resolution flow

Every request resolves a tenant before any domain query fires. Two
phases:

1. **Auth time**: JWT payload gains a `tenant` claim (the slug). The
   `/auth/login` route accepts an additional `tenantSlug` parameter,
   verifies the user belongs to that tenant, and embeds the slug in
   the issued JWT.

2. **Request time**: a Fastify preHandler reads the slug from
   `req.user.tenant`, looks up the `Tenant` row, asserts status is
   ACTIVE, and binds the request's Prisma client to the tenant's
   schema via `SET LOCAL search_path = "tenant_<slug>", public;`.

The `public` fallback in `search_path` is so cross-cutting tables
(Tenant, License, AuditLog) stay reachable from the same client.

### The `RequestContext` pattern

Introduce a per-request context that carries the tenant + the
schema-bound Prisma client. All repo layer calls receive the context
rather than reading `app.prisma` directly:

```ts
// Before (current code):
const customers = await prisma.customer.findMany(...);

// After:
const customers = await ctx.prisma.customer.findMany(...);
```

The `ctx.prisma` is a Prisma client whose connection has run
`SET LOCAL search_path` — so the same `prisma.customer.findMany()`
hits the right schema automatically without any per-query change.

This is the **biggest mechanical change** in the conversion. Every
repository method that currently takes `prisma` as a constructor arg
needs to take a context instead. Estimated ~30 repository files +
~50 service files touched.

### Login flow changes

```
Before:  POST /auth/login { email, password } → { token }
After:   POST /auth/login { tenantSlug, email, password } → { token }
```

**Login URL strategy** — two options:

- **Subdomain**: `mt-banahaw.smartloan.app/login` — slug derived from
  the hostname. Pretty URLs but requires wildcard DNS + cert.
- **Path prefix**: `app.smartloan.app/mt-banahaw/login` — slug in the
  URL. No DNS magic, works on any host.

Recommend path prefix to start; subdomain can layer on later.

A separate `POST /platform/login` route on the platform console (Phase 3)
authenticates platform admins (your team) against a different user
table — no tenant scope.

### Migration runner

Migrations need to run against EVERY tenant schema, not just the
default `public`. The runner:

1. Connects to the DB
2. `SELECT id, slug FROM "Tenant" WHERE status != 'ARCHIVED'`
3. For each tenant: `SET search_path = "tenant_<slug>"; prisma migrate deploy`

Implementation lives in `libs/db/src/lib/multi-tenant-migrate.ts`. The
existing `prisma migrate dev` workflow still works for the `public`
schema (Tenant, License, AuditLog migrations).

### Provisioning a new tenant

Atomic operation (single transaction where possible):

1. INSERT into `Tenant` (status = PROVISIONING)
2. `CREATE SCHEMA "tenant_<slug>"`
3. Run all migrations against the new schema
4. Seed the canonical roles + permissions + first ADMIN user
5. UPDATE `Tenant` SET status = 'ACTIVE'

Step 3 is the slow one (~10s for ~50 migrations). The platform UI
shows the tenant in PROVISIONING state during this; the row is
visible immediately but the tenant's API endpoints return 503 until
ACTIVE.

### Conversion checklist (per-feature)

Every feature plugin needs to be audited and converted. Order matters:
do the most-touched first so subsequent features build on the pattern.

- [ ] `RequestContext` type + `app.requireTenant()` preHandler
- [ ] Bind Prisma client to schema via `$executeRaw` on connection
- [ ] customers — most central, 30+ routes
- [ ] loans — 25+ routes
- [ ] kyc
- [ ] scoring
- [ ] accounting (gl + periods + ecl)
- [ ] collections + demand-letters + repossession
- [ ] dorsi + annual-docs + reports
- [ ] cooperative (7 sub-tables)
- [ ] lease
- [ ] auth (the meta-layer that issues tenant-scoped JWTs)
- [ ] rbac + delegations (control plane that lives WITHIN each tenant)
- [ ] notifications (currently single-recipient; need tenant context)
- [ ] jobs (per-tenant scheduling — biggest unsolved design problem)

The jobs problem deserves a separate doc. Likely answer: one
scheduler in the platform process iterating tenants, OR a
job-per-tenant cron triggered by the platform.

### Single-tenant fallback

For dev + small deployments, support a `MULTI_TENANT=false` env that
short-circuits resolution to a default `tenant_default` schema with
no JWT claim required. Keeps the `pnpm dev` story unchanged.

---

## Phase 3 — Platform console

A separate React app at `apps/platform/` (alongside `apps/web/` and
`apps/api/`). The platform console is YOUR (the vendor's) UI — not
something tenants see.

### Scope

- **Tenants list** — every cooperative on this installation, status,
  tier, last-seen, days until expiry
- **Tenant detail** — license history, user count, loan portfolio
  size, recent activity
- **Provision tenant** — slug + name → new schema + migrate + seed
  (long-running; shows progress)
- **Issue license** — replaces `pnpm --filter @loan/licensing issue`
  CLI. Form: tenant + tier + expiry + features + seats → signs token
  → emails it to the tenant admin
- **Revoke license** — set tenant.status = SUSPENDED, tenant's
  next license check fails, premium features lock
- **Aggregate usage** — total loans / customers / payments across all
  tenants. Internal dashboard for the vendor's sales/ops team
- **Audit log of platform actions** — separate from per-tenant
  audit, lives in `public.PlatformAuditLog`

### Auth

Separate from tenant auth. Platform users (your team) authenticate
against a `public.PlatformUser` table. JWT carries `platform: true`
claim; tenant routes reject it, platform routes require it.

Roles within platform: `PLATFORM_ADMIN` (everything), `PLATFORM_SALES`
(view-only + license issuance).

### Backend routes

All under `/platform/` prefix:

```
POST   /platform/auth/login
GET    /platform/tenants
POST   /platform/tenants          (provision)
GET    /platform/tenants/:slug
POST   /platform/tenants/:slug/suspend
POST   /platform/tenants/:slug/restore
POST   /platform/tenants/:slug/archive

POST   /platform/licenses         (issue)
GET    /platform/licenses         (history across all tenants)
POST   /platform/licenses/:jti/revoke

GET    /platform/usage             (cross-tenant rollup)
GET    /platform/audit
```

### Frontend structure

```
apps/platform/
  src/
    App.tsx                  separate router from apps/web
    features/
      tenants/
        pages/TenantsList.tsx
        pages/TenantDetail.tsx
        pages/ProvisionTenant.tsx
      licenses/
        pages/IssueLicense.tsx
        pages/LicenseHistory.tsx
      usage/
        pages/UsageDashboard.tsx
      auth/
        pages/PlatformLogin.tsx
```

Stack: same as `apps/web` (React + Vite + TanStack Query + @loan/ui).
Reuses `libs/ui` primitives — no duplication. Builds independently.

### Deploy model

Two API processes on the same host:

```
apps/api    → tenant API, port 3001, gated by tenant auth
apps/platform-api → platform API, port 3002, gated by platform auth
```

OR a single API process exposing both `/api/v1/*` (tenant) and
`/platform/*` (platform), with the platform routes' preHandler
checking the `platform` JWT claim. Single process is simpler and the
operational footprint is one less thing — recommend that.

### Issuing licenses from the UI

The platform-side `POST /platform/licenses` calls into `@loan/licensing`'s
`signLicense()` directly. The private key lives on the platform host
only — the CLI script (`pnpm --filter @loan/licensing issue`) stays
available for local testing but production issuance happens via the UI
to keep audit trail.

---

## Work breakdown (rough estimates)

### Phase 2

| Item                                                                      | Effort       |
| ------------------------------------------------------------------------- | ------------ |
| RequestContext + Fastify preHandler + Prisma search_path wiring           | 2 days       |
| Auth flow: tenantSlug param, JWT claim, login routes                      | 1 day        |
| Migration runner (per-tenant)                                             | 1 day        |
| Provisioning flow (create schema + run migrations + seed)                 | 2 days       |
| Convert customers feature                                                 | 1 day        |
| Convert loans feature                                                     | 1 day        |
| Convert kyc + scoring + accounting                                        | 2 days       |
| Convert collections + demand-letters + repossession + dorsi + annual-docs | 2 days       |
| Convert cooperative + lease + reports                                     | 1 day        |
| Auth + rbac + delegations conversion                                      | 1 day        |
| Jobs scheduler — multi-tenant aware                                       | 2 days       |
| Testing (cross-tenant isolation tests are mandatory)                      | 2 days       |
| **Total**                                                                 | **~18 days** |

### Phase 3

| Item                                                                 | Effort      |
| -------------------------------------------------------------------- | ----------- |
| `apps/platform-api` API routes + auth                                | 2 days      |
| `apps/platform` Vite scaffold + routing + auth                       | 1 day       |
| Tenants list + detail pages                                          | 2 days      |
| Provision-tenant flow (with progress UX for the slow migration step) | 2 days      |
| License issuance + history pages                                     | 1 day       |
| Usage dashboard (aggregate queries across schemas)                   | 1 day       |
| **Total**                                                            | **~9 days** |

Combined: ~5-6 weeks of focused work for one engineer, longer with
review overhead. A reasonable split for two engineers in parallel is
Phase 2 + Phase 3 in ~3 weeks (Phase 3 doesn't strictly depend on
Phase 2's later features — provisioning + license issuance can be
built against the bare `Tenant` model that already exists).

---

## What's already in `main` to support this

After Phase 1a/b + this commit:

- `Tenant` model + migration in `public` schema (this commit)
- `License` model + verify/sign lib + API + UI (Phase 1a/b)
- `app.requireFeature(flag)` decorator pattern that gates by license
  — ready to compose with the tenant resolution preHandler

The licensing system is the natural input to the platform console: a
new tenant's first action is having a license issued to them.

---

## Risks + open questions

1. **Cross-tenant audit log** — does the `AuditLog` table live in
   `public` (one big table, queryable by platform) or per-tenant
   (isolated, harder to query from platform)? Recommend per-tenant
   with a `last_seen_audit_id` synced to `public` on the schedule.

2. **Backups** — `pg_dump` against the whole DB captures everything;
   per-tenant exports require schema-scoped dumps. Document the
   per-tenant export path in the platform console's tenant-detail page.

3. **Connection pool sizing** — N schemas all hit the same Postgres
   pool. At ~50 tenants we'll need to think about pool partitioning
   or connection limits. PgBouncer in transaction mode is the usual
   answer.

4. **Prisma client per-schema** — Prisma's `search_path` runs at
   connection acquire time; if a connection is reused across requests
   (it is, that's the pool), every request MUST `SET search_path`
   before queries. Verify with a stress test that a misbehaving
   request can't leak the previous request's tenant context.

5. **Tenant slug immutability** — once issued, slugs cannot change
   (rename = data migration). The platform UI should warn about
   this loudly on the provision form.

---

## Recommended sequencing

1. Land this commit (Tenant model + roadmap) ✅
2. Build the platform console FIRST against the existing single-tenant
   API — at this point it's just a license-issuance UI + tenants list
   that shows one row (the default tenant). Lets you ship the
   license-issuance workflow before doing the big Phase 2 refactor.
3. Then do Phase 2 conversion incrementally, feature by feature,
   behind a `MULTI_TENANT=true` env flag so it can be tested in
   parallel with the single-tenant production.
4. When every feature is converted, flip the default to multi-tenant
   and remove the single-tenant fallback.

This sequencing is safer than doing Phase 2 then Phase 3, because
the platform console gives you a place to issue + revoke licenses
mid-conversion if anything breaks.
