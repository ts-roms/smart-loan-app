# Phase 2 implementation plan — schema-per-tenant

Companion to `docs/multi-tenant-roadmap.md`. The roadmap covers
**what** and **why**; this doc covers **how** — concrete patterns,
file-by-file changes, sequencing, and the leak-safety argument.

Audience: the engineer (or AI agent) actually doing the conversion.
If you're skimming for "is this safe?" — go to §6 first.

---

## 1. Survey of the current code

What we're converting:

- **33 feature folders** in `apps/api/src/features/`
- **27 repository classes** exported from `libs/db`
- **35 files** containing `new XService(...)` or `new YRepository(...)`
- **19 usages** of `app.prisma` outside features (jobs, app.ts, lib/)
- **Service instantiation pattern**: eager, at plugin-register time,
  inside each feature's `index.ts`:
  ```ts
  // apps/api/src/features/customers/index.ts (current)
  export async function customerRoutes(app: FastifyInstance) {
    const repo = new CustomerRepository(app.prisma);
    const service = new CustomerService(repo, app.prisma, app.screening);
    const controller = new CustomerController(service);
    app.get("/", controller.list);
    // ...
  }
  ```

This pattern is the central thing Phase 2 has to change. Every
service/repo currently captures `app.prisma` at boot — there's no
hook for swapping in a per-request, schema-bound client.

---

## 2. Decision: per-tenant `PrismaClient` cache

Three real options considered for binding `search_path`:

| Approach                                                     | Verdict                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| **A. PrismaClient per tenant, cached**                       | ✅ **Chosen**                                                                                |
| B. Single client + `$transaction`-wrapped queries            | ❌ Forces every read into a transaction; latency cost; refactor touches every service method |
| C. `$extends` middleware running `SET search_path` per query | ❌ Prisma's connection pool can swap connections between query and `SET`; not provably safe  |

**Why A works**: each tenant's `PrismaClient` is created with
`?schema=tenant_<slug>` in the connection URL. Prisma respects this
at the pool level — the schema is set when each connection is
acquired, not per-query. Connections never leak between tenants
because they belong to different pool instances.

**Trade-offs accepted**:

- ~5 MB memory per client × 50 tenants = ~250 MB resident
- Per-tenant pool size must be small (`connection_limit=3`) so 50
  tenants × 3 = 150 max connections — within reasonable Postgres
  limits. PgBouncer in transaction mode is the standard fallback if
  this becomes tight.
- Adding a new tenant requires instantiating the client lazily on
  first request (cold start ~50ms). Acceptable.

---

## 3. The `TenantPrismaCache` + `RequestContext`

New module: `libs/db/src/tenant-cache.ts`

```ts
import { PrismaClient } from "@prisma/client";

export class TenantPrismaCache {
  private clients = new Map<string, PrismaClient>();
  private readonly baseUrl: URL;
  private readonly perTenantLimit: number;

  constructor(databaseUrl: string, perTenantLimit = 3) {
    this.baseUrl = new URL(databaseUrl);
    this.perTenantLimit = perTenantLimit;
  }

  get(slug: string): PrismaClient {
    let client = this.clients.get(slug);
    if (client) return client;
    const url = new URL(this.baseUrl.toString());
    url.searchParams.set("schema", `tenant_${slug}`);
    url.searchParams.set("connection_limit", String(this.perTenantLimit));
    client = new PrismaClient({
      datasources: { db: { url: url.toString() } },
    });
    this.clients.set(slug, client);
    return client;
  }

  /** Tear down a client (e.g. tenant archived). */
  async release(slug: string): Promise<void> {
    const client = this.clients.get(slug);
    if (!client) return;
    this.clients.delete(slug);
    await client.$disconnect();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.$disconnect()));
    this.clients.clear();
  }
}
```

New Fastify decorator: `app.tenantPrisma` (the cache) and
`req.tenantCtx` (per-request bind).

```ts
// libs/db/src/multi-tenant-plugin.ts
declare module "fastify" {
  interface FastifyInstance {
    tenantPrisma: TenantPrismaCache;
  }
  interface FastifyRequest {
    tenantCtx: { slug: string; prisma: PrismaClient };
  }
}

// preHandler that resolves the tenant and attaches the bound client
export const resolveTenant = async (
  req: FastifyRequest,
  reply: FastifyReply,
) => {
  // In MULTI_TENANT mode, slug comes from the JWT `tenant` claim.
  // In single-tenant mode, slug = DEFAULT_TENANT_SLUG (default: "default")
  // and the schema is `public` (not `tenant_default`) so existing
  // installations keep working with no migration.
  let slug: string;
  if (process.env.MULTI_TENANT === "true") {
    const claim = (req.user as { tenant?: string } | undefined)?.tenant;
    if (!claim) return reply.code(401).send({ error: "MissingTenantClaim" });
    slug = claim;
  } else {
    slug = process.env.DEFAULT_TENANT_SLUG ?? "default";
  }
  // ... look up Tenant row, check status, bind client
  req.tenantCtx = { slug, prisma: req.server.tenantPrisma.get(slug) };
};
```

---

## 4. Service wiring — the mechanical refactor

Two paths considered:

### Path A: per-request service instantiation (RECOMMENDED)

Move service construction out of the feature's `index.ts` and into
either (i) the route handler or (ii) a `req.services` decorator. We
recommend (ii) — one wiring point per feature, lazy-built per
request, garbage-collected by V8 cheaply.

```ts
// apps/api/src/features/customers/index.ts (after)
export async function customerRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", resolveTenant);
  app.addHook("preHandler", async (req) => {
    const { prisma } = req.tenantCtx;
    const repo = new CustomerRepository(prisma);
    const ledgerRepo = new CustomerLedgerRepository(prisma);
    req.services = {
      customer: new CustomerService(repo, prisma, app.screening),
      bulkImport: new BulkImportService(repo, app.screening),
      ledger: new CustomerLedgerService(
        repo,
        ledgerRepo,
        app.notifications,
        prisma,
      ),
    };
  });

  // Route handlers read req.services.customer.* instead of a
  // module-scope `service` variable.
  registerCustomerHttp(app);
}
```

Cost: ~5 µs per request to instantiate the JS objects. Negligible
compared to the DB roundtrip cost of any real query.

### Path B: stateless service singletons taking `prisma` per method

Rejected. Would require changing every service method signature
across ~50 files — far more invasive.

---

## 5. Migration runner

New: `libs/db/src/lib/multi-tenant-migrate.ts`

```ts
export async function migrateAllTenants() {
  const ctrl = createPrismaClient(); // public-schema client
  const tenants = await ctrl.tenant.findMany({
    where: { status: { not: "ARCHIVED" } },
    select: { slug: true },
  });
  for (const { slug } of tenants) {
    const url = makeTenantUrl(slug);
    execSync(`prisma migrate deploy`, {
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
  }
}
```

New CLI: `pnpm --filter @loan/db migrate-tenants` runs the above.

**Provisioning flow** (extends `PlatformService.provisionTenant`):

```
1. INSERT INTO Tenant (status='PROVISIONING')
2. CREATE SCHEMA "tenant_<slug>"
3. Run all migrations against the new schema (≈10s)
4. Seed: canonical roles, permissions, default LoanProducts, first ADMIN
5. UPDATE Tenant SET status='ACTIVE'
```

Step 3 is async — surfaced via `GET /platform/tenants/:slug` polling
the `status` field. UI shows a spinner badge until ACTIVE.

---

## 6. Why this is leak-safe

The leak-safety claim rests on three guarantees:

1. **Pool isolation**. Each tenant's `PrismaClient` owns its own
   connection pool. Connection acquire applies `?schema=tenant_<slug>`
   at acquire time — Postgres binds the schema to the session before
   any query runs.

2. **No cross-pool sharing**. The `TenantPrismaCache` returns the
   same client instance for the same slug, but never returns one
   tenant's client when another slug is requested. The cache key
   is the slug from the verified JWT — never user input.

3. **No bypass path**. Every tenant route registers `resolveTenant`
   as a preHandler. The hook either sets `req.tenantCtx` or 401s.
   A route that forgets the preHandler fails closed: `req.tenantCtx`
   is undefined and `new CustomerRepository(undefined)` throws at
   instantiation, not silently queries the wrong schema.

**Required tests** (gating before merging the conversion):

- Cross-tenant fetch: provision two tenants, insert a customer in
  each, assert that a request scoped to tenant A cannot see tenant B's
  customer.
- Concurrent requests: 50 simultaneous requests alternating between
  tenants, assert no response carries data from the wrong tenant.
- Pool exhaustion: hit one tenant with 10× its `connection_limit`,
  assert other tenants' requests still succeed.

---

## 7. Sequencing (commit boundaries)

Each commit below should be self-contained, typechecks clean, and
preserves single-tenant operation (`MULTI_TENANT=false`).

### Commit P2.1 — Foundation (no behavior change)

- `TenantPrismaCache` + `multi-tenant-plugin.ts`
- `resolveTenant` preHandler with single-tenant fallback
- `req.tenantCtx` decoration + types
- Wire into a single canary feature (`customers`) using Path A pattern
- Add 2 unit tests proving fallback behavior

**Verification**: existing single-tenant smoke tests pass unchanged.

### Commit P2.2 — Migration runner + provisioning

- `multi-tenant-migrate.ts` + `pnpm migrate-tenants` script
- `PlatformService.provisionTenant` extended to create schema + run
  migrations + seed (gated by `MULTI_TENANT=true`)
- Polling status surfaced on tenant detail

**Verification**: provision a fresh tenant; tenant moves PROVISIONING
→ ACTIVE; the new schema has all tables; default ADMIN user can sign
into the (empty) tenant.

### Commit P2.3 — Auth: tenant-scoped login

- `/api/v1/auth/login` accepts optional `tenantSlug` field
- JWT payload gains `tenant` claim
- Single-tenant mode: claim is auto-set to `DEFAULT_TENANT_SLUG`
- Path-prefix routing: `/api/v1/:tenantSlug/auth/login` works in
  parallel with the un-prefixed legacy path (back-compat redirect)

### Commits P2.4 → P2.9 — Feature conversion

Each commit converts a contiguous group of features. Order by
test-criticality + dependency depth:

1. customers (most central; tests prove the pattern works)
2. loans + payments + loan-products + loan-approvals
3. kyc + scoring + dorsi + annual-docs
4. accounting + ecl + reconciliation
5. collections + demand-letters + repossession + lease
6. cooperative + reports + portal + auth + rbac + delegations
7. notifications + jobs (cross-cutting; jobs is the unsolved one)

Each conversion follows §4 Path A. No service signature changes — only
the `index.ts` wiring shifts to per-request.

### Commit P2.10 — Jobs scheduler refactor

The hard one. Background jobs (`@loan/jobs`) currently iterate
`app.prisma` directly. Options:

- **Outer loop**: one scheduler in the platform process iterates
  `Tenant` and for each, builds a tenant-scoped runner.
- **Per-tenant loop**: each tenant's API process runs its own
  scheduler. Simpler but multiplies wakeups by N.

Recommend outer loop, but design TBD. Will land in its own commit
with its own design doc.

### Commit P2.11 — Cutover + remove fallback

- Default `MULTI_TENANT=true` in production env
- Remove the single-tenant `public`-schema fallback path
- Migrate the existing single-tenant install: rename `public` → `tenant_default`,
  insert a `default` row in `Tenant`. One-shot script.

---

## 8. What stays untouched

- The platform routes (`/platform/*`) and their service (
  `apps/api/src/features/platform/`) — they always operate on `public`
  and never read tenant data. Already correct.
- The licensing tables (`License` lives in tenant schema, gets
  migrated per-tenant; `PlatformIssuedLicense` lives in public).
- Anything in `apps/web/` — the tenant frontend is unaffected
  beyond the login form gaining a tenant slug field.
- `apps/platform/` — vendor console, doesn't query tenant data.

---

## 9. Estimated effort

| Commit    | Description                                   | Effort       |
| --------- | --------------------------------------------- | ------------ |
| P2.1      | Foundation (cache + plugin + canary)          | 1.5 days     |
| P2.2      | Migration runner + provisioning               | 1.5 days     |
| P2.3      | Tenant-scoped auth                            | 1 day        |
| P2.4–P2.9 | Feature conversion (33 features in 6 commits) | 6 days       |
| P2.10     | Jobs scheduler refactor                       | 2 days       |
| P2.11     | Cutover + cleanup                             | 1 day        |
| —         | Cross-tenant isolation tests (mandatory)      | 2 days       |
| —         | Buffer for surprises                          | 2 days       |
| **Total** |                                               | **~17 days** |

Lines up with the roadmap's 18-day estimate. Half is mechanical (the
feature conversions); the other half (foundation, jobs, tests) is the
careful work where leaks would hide.

---

## 10. Recommended starting point

**Land P2.1 first.** It's the smallest commit that proves the
pattern works without changing any user-facing behavior. The canary
(customers feature) gives us a working reference for the other 32
feature conversions to follow.

After P2.1, the next break point is after P2.3 — the foundation is
in place and one feature is converted. From there, conversions are
parallelizable across multiple PRs.
