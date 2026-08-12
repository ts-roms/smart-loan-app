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

## Module boundaries

Every project carries two tags, in its own `package.json` under `nx.tags` —
this workspace has no `project.json` files, and Nx 23 reads tags from the
package manifest. `@nx/enforce-module-boundaries` in `eslint.config.mjs` turns
an illegal import into a lint error rather than something a reviewer has to
notice.

**`type:` — which layer the code is, and therefore which way its imports may
point.**

| Tag               | Projects                                                                                                                                    | Meaning                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `type:app`        | `api`, `web`, `platform`, `marketing`                                                                                                       | A deployable. Composes libraries; nothing imports it.            |
| `type:repository` | `db`                                                                                                                                        | The only place Prisma is touched. Persistence for the domain.    |
| `type:domain`     | `accounting`, `loans`, `credit-scoring`, `decisioning`, `kyc`, `licensing`, `auth`, `jobs`, `notifications`, `payments`, `screening`, `pdf` | Business rules. No I/O of its own; providers are injected.       |
| `type:client`     | `api-client`                                                                                                                                | The typed HTTP client. Speaks transport DTOs.                    |
| `type:ui`         | `ui`                                                                                                                                        | Presentation. React components and their styling.                |
| `type:util`       | `shared-types`, `shared-utils`, `features`                                                                                                  | Types, pure helpers, flag registry. The floor — imports nothing. |

| A project tagged  | may import                                     |
| ----------------- | ---------------------------------------------- |
| `type:app`        | `repository`, `domain`, `client`, `ui`, `util` |
| `type:repository` | `domain`, `util`                               |
| `type:domain`     | `domain`, `util`                               |
| `type:client`     | `util`                                         |
| `type:ui`         | `ui`, `util`                                   |
| `type:util`       | `util`                                         |

So a repository may use the domain's pure functions — `loan.repository.ts`
calling `buildEntry` from `@loan/accounting` is the intended direction — but a
domain library can never reach back down to Prisma, and `libs/ui` can never
import a repository at all.

`type:client` is deliberately the tightest: if `api-client` needs a type, that
type belongs in `shared-types`, which is what makes it a shared contract rather
than a leak of server-side vocabulary into the browser.

**`scope:` — which runtime the code is permitted to execute in.**

| Tag             | Projects                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `scope:server`  | `api`, `db`, `auth`, `decisioning`, `jobs`, `notifications`, `payments`, `screening`, `pdf`             |
| `scope:browser` | `web`, `platform`, `marketing`, `ui`, `api-client`                                                      |
| `scope:shared`  | `accounting`, `loans`, `credit-scoring`, `kyc`, `licensing`, `shared-types`, `shared-utils`, `features` |

Server may import server and shared. Browser may import browser and shared.
**Shared may import only shared** — that third rule is the one that matters: it
makes the shared set closed, so no chain of individually-legal imports can carry
`@prisma/client` or `argon2` into a browser bundle. The guarantee holds edge by
edge; it does not depend on the linter walking the graph.

`scope:server` is an assertion about intent as much as about dependencies. Some
of those libraries are pure TypeScript and would technically run anywhere — but
a credit decision, an AML screen, or a password hash evaluated in the browser is
a security defect, not a convenience. `accounting` is `scope:shared` because
`loans` depends on it and `apps/web` depends on `loans`; it is pure arithmetic
with no runtime dependencies, so that is honest rather than a concession.

**Adding a library.** Give it both tags in its `package.json`:

```json
"nx": { "tags": ["type:domain", "scope:shared"] }
```

Two catch-all constraints require every dependency target to carry a `type:` and
a `scope:` tag, so an untagged library fails lint the first time anything
imports it. That is deliberate: the alternative is a new library silently
sitting outside the boundary system. No rule in `eslint.config.mjs` names a
project — the constraints are written against tag patterns, so a newly tagged
library inherits its layer's rules with no config change.

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

| Item                                                      | Impact                                           |
| --------------------------------------------------------- | ------------------------------------------------ |
| `libs/db` mixes repositories and infrastructure utilities | ownership unclear                                |
| Per-feature service wiring is copy-adapted                | improvements do not propagate                    |
| Uploads on local disk                                     | blocks horizontal scaling; see `security.md` S-1 |
