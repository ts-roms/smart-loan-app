/**
 * Public service — self-serve tenant signup.
 *
 * This is the heaviest anonymous endpoint in the system: one
 * unauthenticated call creates a Postgres schema, runs every migration
 * against it, seeds it, and mints an admin account. The guards around
 * it are the only thing standing between a marketing page and
 * unbounded schema creation, so they're what this file pins down.
 *
 * Coverage:
 *   - The MULTI_TENANT guard. Without it, `provisionTenant` inserts a
 *     catalog row, skips the schema entirely, and the caller walks
 *     away holding credentials for a tenant that does not exist.
 *   - A tenant left in PROVISIONING is a failure, not a success. The
 *     vendor console can retry; an anonymous signup has nobody to.
 *   - Licence issuance is best-effort. A host with no signing key
 *     still produces a working tenant — failing the signup would
 *     discard a completed provisioning run.
 *   - Reserved slugs are rejected before any work happens.
 *     Provisioning over `public` would take out the Tenant catalog
 *     itself, which is not recoverable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublicService } from "./public.service";
import { signupTenantSchema } from "./schemas";

const VALID_SIGNUP = {
  slug: "bayanihan-mpc",
  name: "Bayanihan MPC",
  adminName: "Maria Santos",
  adminEmail: "maria@example.ph",
};

interface MockOptions {
  // Note: the mode itself is not configurable here — signupTenant reads
  // process.env.MULTI_TENANT directly, so the suites set it explicitly.
  provision?:
    | {
        ok: true;
        tenant: { id: string; slug: string; name: string; status: string };
        bootstrapPassword?: string | null;
      }
    | { ok: false; kind: "SlugTaken" | "RepoError"; message: string };
  license?: { ok: boolean };
}

function makeService(opts: MockOptions = {}) {
  const provisionTenant = vi.fn().mockResolvedValue(
    opts.provision ?? {
      ok: true,
      tenant: {
        id: "t-1",
        slug: VALID_SIGNUP.slug,
        name: VALID_SIGNUP.name,
        status: "ACTIVE",
      },
      bootstrapPassword: "generated-secret",
    },
  );
  const issueLicense = vi
    .fn()
    .mockResolvedValue(
      opts.license?.ok === false
        ? { ok: false, kind: "NoPrivateKey", message: "no key" }
        : { ok: true, token: "lic", payload: {} },
    );
  const platform = { provisionTenant, issueLicense };

  const leadCreate = vi.fn().mockResolvedValue({ id: "lead-1" });
  const prisma = { lead: { create: leadCreate } };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const service = new PublicService(
    prisma as never,
    log as never,
    platform as never,
  );

  return { service, provisionTenant, issueLicense, leadCreate, log };
}

describe("PublicService.signupTenant — the mode guard", () => {
  const original = process.env.MULTI_TENANT;
  beforeEach(() => {
    delete process.env.MULTI_TENANT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = original;
  });

  it("refuses on a single-tenant install without touching provisioning", async () => {
    // provisionTenant would happily insert a catalog row here and stop,
    // so the caller would be told to sign in to a schema that was never
    // created. Refusing before that is the whole point of the guard.
    const { service, provisionTenant } = makeService();
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ModeDisabled");
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it("proceeds when MULTI_TENANT is enabled", async () => {
    process.env.MULTI_TENANT = "true";
    const { service, provisionTenant } = makeService();
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(true);
    expect(provisionTenant).toHaveBeenCalledOnce();
  });
});

describe("PublicService.signupTenant — provisioning outcomes", () => {
  const original = process.env.MULTI_TENANT;
  beforeEach(() => {
    process.env.MULTI_TENANT = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = original;
  });

  it("treats a tenant stuck in PROVISIONING as a failure", async () => {
    // provisionTenant returns ok:true in this case because the vendor
    // console can retry it. A self-serve signup has nobody to do that,
    // so reporting success would strand the caller with credentials
    // that don't work yet and no way to say so.
    const { service } = makeService({
      provision: {
        ok: true,
        tenant: {
          id: "t-1",
          slug: VALID_SIGNUP.slug,
          name: VALID_SIGNUP.name,
          status: "PROVISIONING",
        },
        bootstrapPassword: null,
      },
    });
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ProvisioningFailed");
  });

  it("passes a taken slug back as something the caller can fix", async () => {
    const { service } = makeService({
      provision: { ok: false, kind: "SlugTaken", message: "exists" },
    });
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("SlugTaken");
    expect(result.message).toMatch(/already taken/i);
  });

  it("does not leak a database error to an anonymous caller", async () => {
    // RepoError is our problem, not theirs, and its message is a raw
    // Prisma string.
    const { service } = makeService({
      provision: {
        ok: false,
        kind: "RepoError",
        message: 'relation "Tenant" violates constraint xyz_pkey',
      },
    });
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ProvisioningFailed");
    expect(result.message).not.toMatch(/constraint|relation|pkey/i);
  });

  it("returns the bootstrap password, which exists nowhere else", async () => {
    const { service } = makeService();
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.bootstrapPassword).toBe("generated-secret");
    expect(result.adminEmail).toBe(VALID_SIGNUP.adminEmail);
  });
});

describe("PublicService.signupTenant — best-effort follow-ups", () => {
  const original = process.env.MULTI_TENANT;
  beforeEach(() => {
    process.env.MULTI_TENANT = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = original;
  });

  it("still succeeds when no licence could be issued, and says so", async () => {
    // Typically a host with no signing key. The tenant is real and
    // usable; licensed features answer 402 until an operator issues a
    // token. Failing here would discard a completed provisioning run.
    const { service } = makeService({ license: { ok: false } });
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.licensed).toBe(false);
  });

  it("reports licensed:true when the trial token was issued", async () => {
    const { service } = makeService();
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.licensed).toBe(true);
  });

  it("succeeds even if the sales lead row fails to insert", async () => {
    // The tenant is already live and the caller is holding working
    // credentials. Reporting failure over bookkeeping would be a lie.
    const { service, leadCreate } = makeService();
    leadCreate.mockRejectedValueOnce(new Error("lead table offline"));
    const result = await service.signupTenant({ input: VALID_SIGNUP });

    expect(result.ok).toBe(true);
  });
});

describe("signupTenantSchema — slug rules", () => {
  it("accepts a normal cooperative slug", () => {
    expect(signupTenantSchema.safeParse(VALID_SIGNUP).success).toBe(true);
  });

  it.each(["public", "platform", "admin", "api", "www"])(
    "rejects the reserved slug %s",
    (slug) => {
      // `public` holds the Tenant catalog itself — provisioning over it
      // would be unrecoverable. The others would collide with routes.
      expect(
        signupTenantSchema.safeParse({ ...VALID_SIGNUP, slug }).success,
      ).toBe(false);
    },
  );

  it.each([
    ["9leading-digit", "must start with a letter"],
    ["Has-Uppercase", "lowercase only"],
    ["has spaces", "no spaces"],
    ["has_underscore", "dashes only"],
    ["a", "too short"],
  ])("rejects %s (%s)", (slug) => {
    expect(
      signupTenantSchema.safeParse({ ...VALID_SIGNUP, slug }).success,
    ).toBe(false);
  });

  it("requires a real admin email — this is the only way credentials reach anyone", () => {
    expect(
      signupTenantSchema.safeParse({ ...VALID_SIGNUP, adminEmail: undefined })
        .success,
    ).toBe(false);
    expect(
      signupTenantSchema.safeParse({ ...VALID_SIGNUP, adminEmail: "not-email" })
        .success,
    ).toBe(false);
  });
});
