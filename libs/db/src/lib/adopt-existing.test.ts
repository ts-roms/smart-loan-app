/**
 * Adoption pre-flight tests. These guard the safety checks that
 * prevent `adoptExistingAsTenant` from running against a database
 * where it would do the wrong thing:
 *
 *   - target schema already exists → would clobber an existing tenant
 *   - public is empty → operator pointed at the wrong DB
 *   - public.Tenant already has rows → multi-tenant has already started,
 *     a rename would clobber the platform catalog
 *
 * We don't exercise the rename + migrate paths here (those need a live
 * Postgres + the prisma CLI; covered by the manual cutover smoke).
 * The unit-level concern is "we refused to run when we should have."
 */

import { describe, expect, it, vi } from "vitest";

import { adoptExistingAsTenant } from "./adopt-existing";

function makePrisma(opts: {
  targetSchemaExists?: boolean;
  publicTableCount?: number;
  tenantRowCount?: number;
}) {
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join("");
      if (text.includes("information_schema.schemata")) {
        return [{ exists: opts.targetSchemaExists ?? false }];
      }
      if (text.includes("information_schema.tables")) {
        return [{ count: BigInt(opts.publicTableCount ?? 0) }];
      }
      return [];
    }),
    tenant: {
      count: vi.fn(async () => opts.tenantRowCount ?? 0),
    },
    // The following are wired so calling them in a test that should
    // have rejected earlier surfaces an obvious failure.
    $executeRawUnsafe: vi.fn(async () => {
      throw new Error(
        "$executeRawUnsafe should not be reached in pre-flight failures",
      );
    }),
    $transaction: vi.fn(async () => {
      throw new Error(
        "$transaction should not be reached in pre-flight failures",
      );
    }),
    platformUser: { create: vi.fn() },
  } as unknown as Parameters<typeof adoptExistingAsTenant>[0];
}

const COMMON_OPTS = {
  slug: "acme-coop",
  name: "Acme Cooperative",
  platformAdminEmail: "ops@vendor.com",
  platformAdminName: "Vendor Ops",
  hashPassword: async (s: string) => `hashed:${s}`,
  baseDatabaseUrl: "postgresql://app:pw@localhost:5432/loan",
  skipBackup: true,
};

describe("adoptExistingAsTenant — pre-flight gates", () => {
  it("rejects an unsafe slug before touching the DB", async () => {
    const prisma = makePrisma({});
    await expect(
      adoptExistingAsTenant(prisma, { ...COMMON_OPTS, slug: "BAD slug" }),
    ).rejects.toThrow(/unsafe slug/i);
  });

  it("rejects when the target tenant schema already exists", async () => {
    const prisma = makePrisma({ targetSchemaExists: true });
    await expect(adoptExistingAsTenant(prisma, COMMON_OPTS)).rejects.toThrow(
      /already exists/i,
    );
  });

  it("rejects when public has no tables (fresh DB, wrong target)", async () => {
    const prisma = makePrisma({ publicTableCount: 0 });
    await expect(adoptExistingAsTenant(prisma, COMMON_OPTS)).rejects.toThrow(
      /has no tables/i,
    );
  });

  it("rejects when public.Tenant already has rows", async () => {
    const prisma = makePrisma({ publicTableCount: 42, tenantRowCount: 3 });
    await expect(adoptExistingAsTenant(prisma, COMMON_OPTS)).rejects.toThrow(
      /already has rows/i,
    );
  });

  it("requires DATABASE_URL or baseDatabaseUrl", async () => {
    const prisma = makePrisma({ publicTableCount: 42 });
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await expect(
        adoptExistingAsTenant(prisma, {
          ...COMMON_OPTS,
          baseDatabaseUrl: undefined,
        }),
      ).rejects.toThrow(/DATABASE_URL/);
    } finally {
      if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    }
  });
});
