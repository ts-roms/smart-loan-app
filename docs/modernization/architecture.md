# Architecture

Living reference. The judgement calls and their reasoning are in
`recommended-architecture.md`; the point-in-time findings are in
`architecture-audit.md`. This is how the system is put together.

---

## Shape

```
apps/web (68 routes) · apps/platform · apps/marketing     React 18 + Vite 6, PWA
        │
        │  REST /api/v1  ·  zod-validated  ·  Bearer + refresh rotation
        ▼
apps/api — Fastify 5.11                                   41 features, 319 routes
        │
        ├─ *.routes.ts      requirePermission("key") per route
        ├─ *.controller.ts  zod-parse → service → union → HTTP code
        ├─ *.service.ts     orchestration, discriminated-union results
        └─ libs/db          repositories — the only place Prisma is touched
        ▼
Prisma 6.19 → PostgreSQL                                  71 models, 65 migrations
                                                          schema-per-tenant
```

18 libraries: `db`, `accounting`, `loans`, `credit-scoring`, `decisioning`,
`kyc`, `payments`, `screening`, `notifications`, `jobs`, `pdf`, `auth`,
`licensing`, `features`, `api-client`, `shared-types`, `shared-utils`, `ui`.

## Request lifecycle

```
authenticate        verify JWT; enforce sessionsRevokedAt; stamp lastSeenAt
     ↓
resolveTenant       bind req.tenantCtx.prisma to the tenant schema
     ↓
buildXServices      construct the feature's services on THAT client
     ↓
requirePermission   resolve permissions from role assignments in the DB
     ↓
handler
```

Controllers are stateless singletons that read services off the request. The
cost is a few microseconds of allocation; the benefit is that no code path can
query the wrong tenant's schema, because there is no ambient client to reach
for.

## Conventions worth keeping

**Discriminated-union results.** Services return
`{ ok: true, … } | { ok: false, kind: … }` rather than throwing for control
flow. Controllers map `kind` to a status code. Exceptions are reserved for
genuine faults.

**409 means "well-formed but the state refuses."** Consistently used across
`AmlBlocked`, `HasLiveLoan`, `CustomerErased`, `CustomerArchived`,
`HasOpenLoans`, `LoanNotDecidable`, `LoanNotPayable`, `LastAdmin`, `Self`. The
message names the obstruction rather than merely refusing, so the UI can be
actionable.

**Permission keys are shared verbatim.** A UI control gates on the exact key the
endpoint it calls requires. The UI gate is never the only gate.

**Guarantees live in the database.** See `financial-engine.md`. Application code
may read first as a fast path; it may not treat that read as the guarantee.

## Multi-tenancy

Schema-per-tenant: `CREATE SCHEMA "tenant_<slug>"`. Resolution and client
binding in `multi-tenant-plugin.ts`; migration fan-out in
`multi-tenant-migrate.ts`; client reuse in `tenant-cache.ts`; absorbing a
pre-existing database in `adopt-existing.ts`. Guarded by
`tenant-isolation.test.ts`.

Platform support access is by explicit impersonation, and every impersonated
action records both the tenant user and the platform operator.

## Background work

`libs/jobs` is an in-process scheduler over `ScheduledJob` rows, ticked by
`setInterval` and fanned out per tenant by `TenantScheduler`. Not BullMQ —
deliberately, and the handler signature is queue-shaped so swapping is a runtime
change rather than a code change.

Slots are claimed by compare-and-swap on `nextRunAt` before the job runs, which
is what makes a slow job safe (it can no longer restart on top of itself) and
makes a second API process safe (only one wins the slot).

## Known architectural debt

| Item                                                      | Impact                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| No Nx module-boundary tags                                | nothing prevents a UI package importing a repository |
| `libs/db` mixes repositories and infrastructure utilities | ownership unclear                                    |
| Per-feature service wiring is copy-adapted                | improvements do not propagate                        |
| Uploads on local disk                                     | blocks horizontal scaling; see `security.md` S-1     |
