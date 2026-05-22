import { describe, expect, it, vi, afterEach } from "vitest";

import { TenantPrismaCache } from "./tenant-cache";

/**
 * Unit tests for TenantPrismaCache.
 *
 * These do NOT exercise live Postgres — that's integration-test
 * territory (see scripts/test-tenant-isolation.ts when we add it).
 * What we CAN verify here without a DB:
 *
 *   • Lazy instantiation: get() returns the same instance for the same slug
 *   • Slug-keyed isolation: different slugs get different instances
 *   • DSN mutation: the cached client's URL carries the right schema param
 *   • Tear-down: release() removes the entry, closeAll() clears all
 *
 * We use vi.mock on @prisma/client to keep the test hermetic — we
 * never want a real $connect attempt during unit tests.
 */

vi.mock("@prisma/client", () => {
  // Counter so we can tell instances apart without needing real
  // PrismaClient behavior.
  let nextId = 0;
  return {
    PrismaClient: class MockPrismaClient {
      readonly id = ++nextId;
      readonly opts: unknown;
      disconnected = false;
      constructor(opts: unknown) {
        this.opts = opts;
      }
      async $disconnect() {
        this.disconnected = true;
      }
    },
  };
});

const BASE_URL =
  "postgres://loan:loan@localhost:5432/smart_loan?connection_limit=10";

afterEach(() => {
  vi.clearAllMocks();
});

describe("TenantPrismaCache.get", () => {
  it("returns the same instance for repeated calls with the same slug", () => {
    const cache = new TenantPrismaCache({ databaseUrl: BASE_URL });
    const a1 = cache.get("acme");
    const a2 = cache.get("acme");
    expect(a1).toBe(a2);
  });

  it("returns DIFFERENT instances for different slugs", () => {
    const cache = new TenantPrismaCache({ databaseUrl: BASE_URL });
    const a = cache.get("acme");
    const b = cache.get("beta");
    expect(a).not.toBe(b);
  });

  it("embeds the tenant_<slug> schema in the connection URL", () => {
    const cache = new TenantPrismaCache({ databaseUrl: BASE_URL });
    // We bypass the type to read the captured opts from the mock.
    const client = cache.get("mt-banahaw") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    const url = new URL(client.opts.datasources.db.url);
    expect(url.searchParams.get("schema")).toBe("tenant_mt-banahaw");
  });

  it("respects the per-tenant connection limit", () => {
    const cache = new TenantPrismaCache({
      databaseUrl: BASE_URL,
      perTenantConnectionLimit: 7,
    });
    const client = cache.get("acme") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    const url = new URL(client.opts.datasources.db.url);
    expect(url.searchParams.get("connection_limit")).toBe("7");
  });

  it("overrides the base URL's connection_limit (caller-supplied is authoritative)", () => {
    // BASE_URL has connection_limit=10 baked in; constructor default is 3.
    const cache = new TenantPrismaCache({ databaseUrl: BASE_URL });
    const client = cache.get("acme") as unknown as {
      opts: { datasources: { db: { url: string } } };
    };
    const url = new URL(client.opts.datasources.db.url);
    expect(url.searchParams.get("connection_limit")).toBe("3");
  });
});

describe("TenantPrismaCache.release", () => {
  it("disconnects + removes the cached client", async () => {
    const cache = new TenantPrismaCache({ databaseUrl: BASE_URL });
    const before = cache.get("acme") as unknown as { disconnected: boolean };
    expect(cache.cachedSlugs()).toContain("acme");
    expect(before.disconnected).toBe(false);

    await cache.release("acme");
    expect(before.disconnected).toBe(true);
    expect(cache.cachedSlugs()).not.toContain("acme");

    // A subsequent get() builds a fresh instance — the disconnected
    // one is gone.
    const after = cache.get("acme");
    expect(after).not.toBe(before);
  });

  it("is a no-op for an unknown slug", async () => {
    const cache = new TenantPrismaCache({ databaseUrl: BASE_URL });
    await expect(cache.release("never-built")).resolves.toBeUndefined();
  });
});

describe("TenantPrismaCache.closeAll", () => {
  it("disconnects every cached client and clears the map", async () => {
    const cache = new TenantPrismaCache({ databaseUrl: BASE_URL });
    const a = cache.get("acme") as unknown as { disconnected: boolean };
    const b = cache.get("beta") as unknown as { disconnected: boolean };

    await cache.closeAll();

    expect(a.disconnected).toBe(true);
    expect(b.disconnected).toBe(true);
    expect(cache.cachedSlugs()).toEqual([]);
  });
});
