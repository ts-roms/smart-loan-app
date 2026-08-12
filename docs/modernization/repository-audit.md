# Repository Audit — Phase 0

**Audited:** the working copy at `D:\codespaces\commercial\smart-loan-app`, branch
`feat/version-update`, 266 commits. Not the GitHub mirror — the local tree is the
source of truth for every number below, and every figure was produced by reading
or counting files, not by recall.

**Scope:** observation only. No production behaviour was changed to produce this
document.

---

## A. Actual architecture

The system as built (not as aspired to):

```
apps/web  apps/platform  apps/marketing        3 separate React 18 + Vite 6 SPAs
        │                                       (PWA via vite-plugin-pwa)
        │  REST /api/v1  (Vite proxy → 127.0.0.1:3001 in dev)
        ▼
apps/api                                        Fastify 5.11
        │
        ├─ routes  (42 *.routes.ts across 41 feature folders)
        ├─ controllers  (thin, zod-parse → service → HTTP code mapping)
        ├─ services     (orchestration, discriminated-union results)
        └─ repositories (libs/db — Prisma only)
        │
        ▼
Prisma 6.19.3  →  PostgreSQL
                  schema-per-tenant: CREATE SCHEMA "tenant_<slug>"
```

Per-request tenant binding is real and load-bearing: `authenticate` →
`resolveTenant` → a per-request service container built on
`req.tenantCtx.prisma`. Controllers are stateless singletons reading services
off the request, so no code path can query the wrong schema by construction
(`apps/api/src/features/customers/index.ts` documents the pattern).

**Layering is already what the target asks for.** The "Route → Controller →
Service → Repository → Prisma" shape in the brief is not a change to make; it is
the shape that exists.

## B. Actual technology stack

| Layer         | Actual                                                | Notes                                                                         |
| ------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Monorepo      | Nx 23.1.1, pnpm 9.15.0 (pinned via `packageManager`)  | 4 apps, 18 libs                                                               |
| API           | Fastify 5.11, fastify-plugin 5.1                      | + helmet, cors, rate-limit, multipart, sensible, static, swagger + swagger-ui |
| ORM           | Prisma 6.19.3 / @prisma/client 6.19.3                 | 65 migrations, hand-written                                                   |
| DB            | PostgreSQL                                            | dev on :5433 via docker-compose                                               |
| Frontend      | React 18.3, Vite 6.4, react-router-dom 7.18           | **three** SPAs, all Vite                                                      |
| State/data    | TanStack Query 5.101                                  |                                                                               |
| Styling       | Tailwind 3.4                                          |                                                                               |
| Validation    | zod 3.25                                              | shared between API schemas and forms                                          |
| Types         | TypeScript 5.7.3                                      |                                                                               |
| Tests         | vitest 4.1.10                                         | 47 test files                                                                 |
| PWA           | vite-plugin-pwa 0.21                                  |                                                                               |
| Auth          | argon2id, JWT, refresh-token rotation, TOTP 2FA       |                                                                               |
| Observability | Sentry (wired in `apps/api/src/app.ts` + `config.ts`) |                                                                               |

**Not present, despite being named in the target:**

- **Next.js** — zero occurrences in any `package.json`. All three frontends are Vite SPAs.
- **Redis / BullMQ** — not a dependency. `libs/jobs` is an in-process `setInterval`
  scheduler reading `ScheduledJob` rows, and its header explains the choice
  deliberately: _"Why not BullMQ? It's a real queue with Redis. We don't need
  Redis-level..."_ — the handler signature was kept BullMQ-shaped so swapping is
  a runtime change, not a code change. This is a considered decision, not an omission.
- **S3 / MinIO** — uploads go to a local directory (`config.uploadsDir`, served by a
  static plugin). This is the one infrastructure gap with real operational
  consequence (see `modernization-gap-analysis.md`, GAP-07).

**Version note:** the brief states "Current Version: v1.0.0"; `package.json` says
`0.1.0`, while `docs/RELEASE-1.0.0.md` exists. The tag and the manifest disagree —
worth reconciling before any release automation depends on the manifest.

## C. Database architecture

- **3,373 lines** of `schema.prisma`, **71 models**, **52 enums**, **65 migrations**.
- **48 unique constraints**.
- Multi-tenancy: schema-per-tenant (`libs/db/src/lib/multi-tenant-migrate.ts`
  creates `tenant_<slug>`; `libs/db/src/multi-tenant-plugin.ts` resolves and binds).
  `libs/db/src/lib/adopt-existing.ts` handles absorbing a pre-existing database.

**Money typing — the headline finding, and it is good.** The single most common
fatal defect in an LMS is floating-point money. It is not present here:

|                                                          | Count |
| -------------------------------------------------------- | ----- |
| `Decimal` fields                                         | 79    |
| `Decimal` fields **without** explicit `@db.Decimal(p,s)` | **0** |
| `Float`/`Double` fields                                  | 5     |
| …of which monetary                                       | **0** |

The five `Float` columns are `SurveyFactor.weight` (a relative ratio),
`selfieMatchScore` / `selfieMatchDistance` (biometric distances) and the two
DORSI `*UtilizationPct` percentages. All are legitimately non-monetary.

Declared precision, by frequency: `(14,2)` ×45 — the standard money column;
`(18,2)` ×11 and `(20,2)` ×1 — aggregates; `(5,4)` ×11 and `(6,4)` ×8 — interest
rates; `(10,2)`, `(5,2)` ×1 each.

**Conclusion: §11 of the brief (Money Type Rule) is already satisfied.** No
migration is required. What is _not_ yet documented anywhere is the rounding
mode and allocation precision — see `financial-engine-audit.md`.

## D. Current LMS capabilities

Verified present by locating the feature folder, routes and Prisma models — not
inferred from the brief.

| Capability                                           | Where                                                | Assessment                |
| ---------------------------------------------------- | ---------------------------------------------------- | ------------------------- |
| Customer onboarding, 360 view                        | `features/customers`, `apps/web/.../customers`       | EXISTS — GOOD             |
| KYC + per-product declarations                       | `libs/kyc`, `features/kyc`                           | EXISTS — GOOD             |
| Credit scoring (catalog-driven)                      | `libs/credit-scoring`, `features/scoring`            | EXISTS — GOOD             |
| Decisioning rules                                    | `libs/decisioning`, `features/decision-rules`        | EXISTS — GOOD             |
| Loan products (salary/auto/motorcycle/housing/lease) | `features/loan-products`, `LoanProduct.config`       | EXISTS — config-driven    |
| Application → decision → disburse                    | `features/loans`                                     | EXISTS — see risk P0-3    |
| Amortization                                         | `libs/loans` (6 test files)                          | EXISTS — best-tested area |
| Payments + allocation                                | `features/payments`, `libs/payments`                 | EXISTS — see risk P0-2    |
| Collections, PTP, demand letters                     | `features/collections`, `features/demand-letters`    | EXISTS — GOOD             |
| Repossession                                         | `features/repossession`                              | EXISTS                    |
| Lease-to-own                                         | `features/lease`                                     | EXISTS                    |
| Double-entry accounting + GL                         | `libs/accounting`, `features/accounting`             | EXISTS — see risk P0-1    |
| Period close/reopen                                  | `features/accounting`                                | EXISTS                    |
| Bank reconciliation                                  | `features/reconciliation`                            | EXISTS                    |
| IFRS-9 ECL                                           | `libs/db/.../ecl.repository.ts`, `features/ecl`      | EXISTS                    |
| Cooperative savings/contributions                    | `features/cooperative`                               | EXISTS                    |
| Multi-tenancy + isolation test                       | `features/tenancy` (+ `tenant-isolation.test.ts`)    | EXISTS — GOOD             |
| RBAC, delegation, 2FA                                | `libs/auth`, `features/rbac`, `features/delegations` | EXISTS — GOOD             |
| Audit logging                                        | `AuditLogRepository`, `features/audit`               | EXISTS — GOOD             |
| Notifications                                        | `libs/notifications`, `features/notifications`       | EXISTS                    |
| Screening / AML                                      | `libs/screening`, `features/screening`               | EXISTS                    |
| DORSI compliance                                     | `features/dorsi`                                     | EXISTS                    |
| Data Privacy (DSAR, retention)                       | `features/compliance`                                | EXISTS — GOOD             |
| Agent commissions + payouts                          | `features/agents`                                    | EXISTS                    |
| Platform/vendor console                              | `apps/platform`, `features/platform`                 | EXISTS                    |
| Licensing                                            | `libs/licensing`, `features/licensing`               | EXISTS                    |
| AI assistant                                         | `features/assistant`                                 | EXISTS                    |
| Docs/PDF                                             | `libs/pdf`, `features/documents`                     | EXISTS                    |

**Nothing in the brief's capability list is missing.** The gaps are not features;
they are _guarantees_ — concurrency, idempotency, storage durability, and test
depth. That reframing drives the roadmap.

## API surface

319 route registrations: **139 GET, 143 POST, 14 PATCH, 12 DELETE, 11 PUT**,
across 42 route files. Swagger/OpenAPI is registered and served at `/docs`.

The POST-heavy shape reflects action endpoints (`/loans/:id/disburse`,
`/users/:id/force-logout`) rather than CRUD, which is appropriate for a
workflow system. See `api-audit.md`.

## Frontend surface

36 feature folders, 148 `.tsx` files, 68 routes in `apps/web/src/App.tsx`,
lazy-loaded. Plus `apps/platform` and `apps/marketing` as separate Vite SPAs.

## Housekeeping observation

`.claude/worktrees/` contains two stale full copies of parts of the tree
(`youthful-edison-ef304b`, `adoring-bohr-24cb35`). They inflate any
naive `find`-based count — the honest test-file count is **47**, not 83. They are
untracked scratch space, but should be cleaned or ignored so future audits and
coverage tooling do not double-count.
