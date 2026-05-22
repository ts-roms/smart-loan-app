import { PrismaClient } from "@prisma/client";

/**
 * Per-tenant `PrismaClient` cache for schema-per-tenant multi-tenancy.
 *
 * Each tenant gets its own `PrismaClient` instance with the Postgres
 * `schema=tenant_<slug>` query parameter baked into its connection
 * URL. Prisma's pool then acquires connections bound to that schema
 * — so `tenant_a`'s client physically cannot read `tenant_b`'s data,
 * even if a query is constructed wrong, because the schema is set at
 * the session level before any query runs.
 *
 * This is the leak-safety boundary: separation lives in the
 * connection pool, not in the application code.
 *
 * ## Design notes
 *
 * - Clients are created lazily on first request. The 50ms cold-start
 *   cost is acceptable for the first request after a new tenant
 *   provisions; subsequent requests hit the cache instantly.
 * - Per-tenant `connection_limit` defaults to 3 (vs Prisma's default
 *   of `num_physical_cpus * 2 + 1`). At 50 tenants × 3 = 150 max
 *   connections, which a small RDS instance handles comfortably.
 *   Tune via the constructor arg if your deployment differs.
 * - `release(slug)` should be called when a tenant is ARCHIVED so the
 *   pool's connections free up; we don't auto-release because tenants
 *   come back from SUSPENDED → ACTIVE often enough that keeping the
 *   client warm matters.
 * - Not thread-safe in the multi-process sense — each Node process
 *   maintains its own cache. If you run multiple API processes, each
 *   builds its own per-tenant clients on demand. That's fine; Prisma
 *   was never designed for IPC-shared pools.
 *
 * @see docs/multi-tenant-implementation.md §3 for the bigger picture
 */
export class TenantPrismaCache {
  private clients = new Map<string, PrismaClient>();
  private readonly baseUrl: string;
  private readonly perTenantConnectionLimit: number;

  constructor(opts: {
    /** Base DATABASE_URL — schema param will be overridden per tenant. */
    databaseUrl: string;
    /** Connections per tenant pool. Default 3. */
    perTenantConnectionLimit?: number;
  }) {
    this.baseUrl = opts.databaseUrl;
    this.perTenantConnectionLimit = opts.perTenantConnectionLimit ?? 3;
  }

  /**
   * Get (or lazily build) the client for a tenant slug. The slug is
   * embedded into the schema name as `tenant_<slug>` — callers should
   * have already validated the slug against the same regex used in
   * the platform schema (`^[a-z][a-z0-9-]+$`). Slugs containing
   * SQL-unsafe characters would otherwise produce a DSN that fails
   * at connect time.
   */
  get(slug: string): PrismaClient {
    let client = this.clients.get(slug);
    if (client) return client;

    const url = new URL(this.baseUrl);
    url.searchParams.set("schema", `tenant_${slug}`);
    // Prisma respects connection_limit on the URL; this caps pool
    // size per tenant rather than per process.
    url.searchParams.set(
      "connection_limit",
      String(this.perTenantConnectionLimit),
    );

    client = new PrismaClient({
      datasources: { db: { url: url.toString() } },
      log:
        process.env.NODE_ENV === "production"
          ? ["error", "warn"]
          : ["error", "warn"],
    });
    this.clients.set(slug, client);
    return client;
  }

  /** Returns the slugs currently cached. Mainly for diagnostics. */
  cachedSlugs(): string[] {
    return [...this.clients.keys()];
  }

  /**
   * Disconnect a single tenant's client and remove it from the cache.
   * Use when a tenant is archived or the operator wants to reclaim
   * connections.
   */
  async release(slug: string): Promise<void> {
    const client = this.clients.get(slug);
    if (!client) return;
    this.clients.delete(slug);
    await client.$disconnect();
  }

  /** Disconnect everything. Call from Fastify's onClose hook. */
  async closeAll(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((c) => c.$disconnect().catch(() => {})));
  }
}
