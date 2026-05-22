import { describe, expect, it } from "vitest";

import { tenantDatabaseUrl, tenantSchemaName } from "./multi-tenant-migrate";

/**
 * Unit tests for the multi-tenant migration runner — pure functions
 * only. The shellout (`migrateTenantSchema`) and SQL emission
 * (`createTenantSchema` / `dropTenantSchema`) are integration-test
 * territory; we cover them with the cross-tenant isolation harness
 * (scheduled for P2.11) instead of mocking out child_process + Prisma
 * here.
 *
 * The functions we DO test in isolation are the leak-safety
 * boundary: slug validation and URL mutation. Get those wrong and
 * the cooperative whose data lives in `tenant_acme` could be served
 * to a request scoped to `tenant_evilcorp`.
 */

describe("tenantSchemaName", () => {
  it("prefixes the slug with tenant_", () => {
    expect(tenantSchemaName("acme")).toBe("tenant_acme");
    expect(tenantSchemaName("mt-banahaw-mpc")).toBe("tenant_mt-banahaw-mpc");
  });

  it("rejects slugs that don't match the regex", () => {
    expect(() => tenantSchemaName("Acme")).toThrow(/unsafe tenant slug/);
    expect(() => tenantSchemaName("acme_corp")).toThrow(/unsafe tenant slug/);
    expect(() => tenantSchemaName("acme corp")).toThrow(/unsafe tenant slug/);
    expect(() => tenantSchemaName("")).toThrow(/unsafe tenant slug/);
    expect(() => tenantSchemaName("a")).toThrow(/unsafe tenant slug/);
    expect(() => tenantSchemaName("1acme")).toThrow(/unsafe tenant slug/);
  });

  it("blocks SQL-injection payloads in slugs", () => {
    // The motivating case for this check. If any of these slipped
    // through, the next $executeRawUnsafe would compromise the DB.
    //
    // Note: trailing-dash-only payloads like "acme--" actually pass
    // the regex AND are safe — they appear inside a double-quoted
    // identifier in the generated SQL, so `--` doesn't start a
    // comment there. The defense-in-depth is regex (reject the
    // unquotable chars) + always double-quote the identifier. Both
    // layers have to hold.
    const evil = [
      'acme"; DROP TABLE "User',
      "acme'; DROP SCHEMA public CASCADE; --",
      "../../etc/passwd",
      "acme\nDROP",
      "acme;DROP",
      "acme/*",
    ];
    for (const slug of evil) {
      expect(() => tenantSchemaName(slug)).toThrow(/unsafe tenant slug/);
    }
  });
});

describe("tenantDatabaseUrl", () => {
  const BASE = "postgres://user:pass@localhost:5432/smart_loan";

  it("adds schema=tenant_<slug> to the URL", () => {
    const url = new URL(tenantDatabaseUrl(BASE, "acme"));
    expect(url.searchParams.get("schema")).toBe("tenant_acme");
  });

  it("replaces a pre-existing schema param", () => {
    const baseWithSchema = BASE + "?schema=public";
    const url = new URL(tenantDatabaseUrl(baseWithSchema, "acme"));
    expect(url.searchParams.get("schema")).toBe("tenant_acme");
  });

  it("optionally sets connection_limit", () => {
    const url = new URL(
      tenantDatabaseUrl(BASE, "acme", { connectionLimit: 2 }),
    );
    expect(url.searchParams.get("connection_limit")).toBe("2");
  });

  it("preserves the rest of the URL", () => {
    const url = new URL(tenantDatabaseUrl(BASE, "acme"));
    expect(url.username).toBe("user");
    expect(url.password).toBe("pass");
    expect(url.hostname).toBe("localhost");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/smart_loan");
  });

  it("refuses to build a URL for an unsafe slug", () => {
    expect(() => tenantDatabaseUrl(BASE, 'evil"--')).toThrow(
      /unsafe tenant slug/,
    );
  });
});
