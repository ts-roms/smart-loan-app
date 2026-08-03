/**
 * Public service — self-serve tenant signup.
 *
 * Signup is two steps because the second one is expensive and
 * irreversible-ish: one call creates a Postgres schema, runs every
 * migration against it, seeds it, and mints an admin whose password is
 * shown exactly once. Step 1 records the request and emails a token;
 * step 2 redeems it and provisions.
 *
 * What this file pins down, in order of what would hurt most:
 *
 *   - Requesting provisions NOTHING. If that regressed, the email gate
 *     would be decorative and a typo'd address would again produce a
 *     live tenant nobody can reach.
 *   - The token is stored hashed and never returned. A database leak,
 *     or a response body in a log, must not hand anyone the ability to
 *     provision.
 *   - Every refusal on the confirm path happens before provisioning.
 *   - The token is claimed atomically, so a double-click can't build
 *     two schemas for one signup.
 *   - The MULTI_TENANT guard on both steps. Without it provisionTenant
 *     inserts a catalog row, skips the schema, and the caller walks
 *     away holding credentials for a tenant that doesn't exist.
 *   - Reserved slugs. Provisioning over `public` would take out the
 *     Tenant catalog itself.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublicService } from "./public.service";
import { confirmSignupSchema, signupTenantSchema } from "./schemas";

const VALID_SIGNUP = {
  slug: "bayanihan-mpc",
  name: "Bayanihan MPC",
  adminName: "Maria Santos",
  adminEmail: "maria@example.ph",
};

const MARKETING = "https://smartloan.test";

/** A pending row as the database would return it. */
function pendingRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pending-1",
    slug: VALID_SIGNUP.slug,
    name: VALID_SIGNUP.name,
    adminEmail: VALID_SIGNUP.adminEmail,
    adminName: VALID_SIGNUP.adminName,
    tokenHash: "irrelevant-here",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    consumedAt: null,
    tenantSlug: null,
    createdAt: new Date(),
    ...over,
  };
}

interface MockOptions {
  // Note: the mode itself is not configurable here — both steps read
  // process.env.MULTI_TENANT directly, so the suites set it explicitly.
  slugTaken?: boolean;
  pending?: ReturnType<typeof pendingRow> | null;
  /** Rows affected by the atomic claim. 0 means someone else won. */
  claimCount?: number;
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

  const pendingCreate = vi
    .fn()
    .mockImplementation(({ data }) => ({ id: "pending-1", ...data }));
  const pendingFindUnique = vi.fn().mockResolvedValue(opts.pending ?? null);
  const pendingUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: opts.claimCount ?? 1 });
  const pendingUpdate = vi.fn().mockResolvedValue({});
  const tenantFindUnique = vi
    .fn()
    .mockResolvedValue(opts.slugTaken ? { id: "t-existing" } : null);
  const leadCreate = vi.fn().mockResolvedValue({ id: "lead-1" });

  const prisma = {
    lead: { create: leadCreate },
    tenant: { findUnique: tenantFindUnique },
    pendingTenantSignup: {
      create: pendingCreate,
      findUnique: pendingFindUnique,
      updateMany: pendingUpdateMany,
      update: pendingUpdate,
    },
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const send = vi.fn().mockResolvedValue({ providerRef: "mock-1" });
  const notifications = { name: "MOCK", channels: new Set(["EMAIL"]), send };

  const service = new PublicService(
    prisma as never,
    log as never,
    platform as never,
    notifications as never,
    MARKETING,
  );

  return {
    service,
    provisionTenant,
    issueLicense,
    leadCreate,
    pendingCreate,
    pendingFindUnique,
    pendingUpdateMany,
    send,
    log,
  };
}

/** Pull the confirmation URL out of the email the service sent. */
function confirmUrlFrom(send: ReturnType<typeof vi.fn>): string {
  const body = (send.mock.calls[0]![0] as { body: string }).body;
  const match = /https?:\/\/\S+/.exec(body);
  if (!match) throw new Error("no URL in the email body");
  return match[0];
}

function tokenFrom(send: ReturnType<typeof vi.fn>): string {
  return new URL(confirmUrlFrom(send)).searchParams.get("token")!;
}

// ─── Mode guard ──────────────────────────────────────────────────────

describe("signup — the MULTI_TENANT guard", () => {
  const original = process.env.MULTI_TENANT;
  beforeEach(() => {
    delete process.env.MULTI_TENANT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = original;
  });

  it("refuses to request on a single-tenant install, recording nothing", async () => {
    const { service, pendingCreate, send } = makeService();
    const result = await service.requestTenantSignup({ input: VALID_SIGNUP });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ModeDisabled");
    expect(pendingCreate).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to confirm on a single-tenant install, without touching provisioning", async () => {
    const { service, provisionTenant } = makeService({ pending: pendingRow() });
    const result = await service.confirmTenantSignup({ token: "a".repeat(64) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ModeDisabled");
    expect(provisionTenant).not.toHaveBeenCalled();
  });
});

// ─── Step 1: request ─────────────────────────────────────────────────

describe("requestTenantSignup — records and emails, provisions nothing", () => {
  const original = process.env.MULTI_TENANT;
  beforeEach(() => {
    process.env.MULTI_TENANT = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = original;
  });

  it("provisions nothing — the whole point of the step", async () => {
    const { service, provisionTenant, issueLicense } = makeService();
    const result = await service.requestTenantSignup({ input: VALID_SIGNUP });

    expect(result.ok).toBe(true);
    expect(provisionTenant).not.toHaveBeenCalled();
    expect(issueLicense).not.toHaveBeenCalled();
  });

  it("never returns the token — only the inbox gets it", async () => {
    const { service, send } = makeService();
    const result = await service.requestTenantSignup({ input: VALID_SIGNUP });

    const token = tokenFrom(send);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("stores the token hashed, never in plaintext", async () => {
    // A database leak must not hand anyone the ability to provision.
    const { service, send, pendingCreate } = makeService();
    await service.requestTenantSignup({ input: VALID_SIGNUP });

    const token = tokenFrom(send);
    const stored = (
      pendingCreate.mock.calls[0]![0] as { data: { tokenHash: string } }
    ).data.tokenHash;
    expect(stored).not.toBe(token);
    expect(stored).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("emails a confirmation link on the marketing origin", async () => {
    const { service, send } = makeService();
    await service.requestTenantSignup({ input: VALID_SIGNUP });

    expect(send).toHaveBeenCalledOnce();
    const call = send.mock.calls[0]![0] as {
      channel: string;
      recipient: string;
    };
    expect(call.channel).toBe("EMAIL");
    expect(call.recipient).toBe(VALID_SIGNUP.adminEmail);
    expect(confirmUrlFrom(send)).toContain(
      `${MARKETING}/signup/confirm?token=`,
    );
  });

  it("refuses a slug that already belongs to a tenant", async () => {
    const { service, pendingCreate } = makeService({ slugTaken: true });
    const result = await service.requestTenantSignup({ input: VALID_SIGNUP });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("SlugTaken");
    expect(pendingCreate).not.toHaveBeenCalled();
  });

  it("still succeeds when the email fails to send", async () => {
    // The row is written and the link is reproducible by requesting
    // again. Reporting failure would also tell an anonymous caller
    // whether delivery worked, which is an address-probing oracle.
    const { service, send } = makeService();
    send.mockRejectedValueOnce(new Error("smtp down"));
    const result = await service.requestTenantSignup({ input: VALID_SIGNUP });

    expect(result.ok).toBe(true);
  });
});

// ─── Step 2: confirm ─────────────────────────────────────────────────

describe("confirmTenantSignup — every refusal precedes provisioning", () => {
  const original = process.env.MULTI_TENANT;
  beforeEach(() => {
    process.env.MULTI_TENANT = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = original;
  });

  const TOKEN = "b".repeat(64);

  it("refuses an unknown token", async () => {
    const { service, provisionTenant } = makeService({ pending: null });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("InvalidToken");
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it("refuses an expired token", async () => {
    const { service, provisionTenant } = makeService({
      pending: pendingRow({ expiresAt: new Date(Date.now() - 1000) }),
    });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("Expired");
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it("refuses a token that was already redeemed", async () => {
    const { service, provisionTenant } = makeService({
      pending: pendingRow({ consumedAt: new Date() }),
    });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("AlreadyUsed");
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it("loses the claim race rather than provisioning twice", async () => {
    // Two clicks in quick succession — a double-click, a mail client
    // prefetch, a retry — both pass the checks above. The conditional
    // claim is what stops the loser: two schemas for one signup would
    // leave one admin unreachable.
    const { service, provisionTenant } = makeService({
      pending: pendingRow(),
      claimCount: 0,
    });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("AlreadyUsed");
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it("claims the token before provisioning, conditional on it being unclaimed", async () => {
    const { service, pendingUpdateMany } = makeService({
      pending: pendingRow(),
    });
    await service.confirmTenantSignup({ token: TOKEN });

    const call = pendingUpdateMany.mock.calls[0]![0] as {
      where: { id: string; consumedAt: null };
    };
    expect(call.where.id).toBe("pending-1");
    expect(call.where.consumedAt).toBeNull();
  });

  it("looks the row up by hash, never by the raw token", async () => {
    // If this ever queried the plaintext, the column would have to hold
    // plaintext too — and the hashing above would be theatre.
    const { service, pendingFindUnique } = makeService({
      pending: pendingRow(),
    });
    await service.confirmTenantSignup({ token: TOKEN });

    const where = (
      pendingFindUnique.mock.calls[0]![0] as {
        where: { tokenHash: string };
      }
    ).where;
    expect(where.tokenHash).toBe(
      createHash("sha256").update(TOKEN).digest("hex"),
    );
    expect(where.tokenHash).not.toBe(TOKEN);
  });
});

describe("confirmTenantSignup — provisioning outcomes", () => {
  const original = process.env.MULTI_TENANT;
  beforeEach(() => {
    process.env.MULTI_TENANT = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MULTI_TENANT;
    else process.env.MULTI_TENANT = original;
  });

  const TOKEN = "c".repeat(64);

  it("returns the bootstrap password, which exists nowhere else", async () => {
    const { service } = makeService({ pending: pendingRow() });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.bootstrapPassword).toBe("generated-secret");
    expect(result.adminEmail).toBe(VALID_SIGNUP.adminEmail);
    expect(result.slug).toBe(VALID_SIGNUP.slug);
  });

  it("reports a slug taken while the user was confirming", async () => {
    // The check at request time was up to 24 hours ago and reserved
    // nothing, so someone else may have taken the name since.
    const { service } = makeService({
      pending: pendingRow(),
      provision: { ok: false, kind: "SlugTaken", message: "exists" },
    });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("SlugTaken");
    expect(result.message).toMatch(/taken while you were confirming/i);
  });

  it("treats a tenant stuck in PROVISIONING as a failure", async () => {
    // provisionTenant returns ok:true there because the vendor console
    // can retry it. A self-serve signup has nobody to do that.
    const { service } = makeService({
      pending: pendingRow(),
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
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ProvisioningFailed");
  });

  it("does not leak a database error to an anonymous caller", async () => {
    const { service } = makeService({
      pending: pendingRow(),
      provision: {
        ok: false,
        kind: "RepoError",
        message: 'relation "Tenant" violates constraint xyz_pkey',
      },
    });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ProvisioningFailed");
    expect(result.message).not.toMatch(/constraint|relation|pkey/i);
  });

  it("still succeeds when no licence could be issued, and says so", async () => {
    // Typically a host with no signing key. The tenant is real and
    // usable; failing here would discard a completed provisioning run.
    const { service } = makeService({
      pending: pendingRow(),
      license: { ok: false },
    });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.licensed).toBe(false);
  });

  it("reports licensed:true when the trial token was issued", async () => {
    const { service } = makeService({ pending: pendingRow() });
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.licensed).toBe(true);
  });

  it("succeeds even if the sales lead row fails to insert", async () => {
    const { service, leadCreate } = makeService({ pending: pendingRow() });
    leadCreate.mockRejectedValueOnce(new Error("lead table offline"));
    const result = await service.confirmTenantSignup({ token: TOKEN });

    expect(result.ok).toBe(true);
  });
});

// ─── Wire schemas ────────────────────────────────────────────────────

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

  it("requires a real admin email — this is the only way the link reaches anyone", () => {
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

describe("confirmSignupSchema — token shape", () => {
  it("accepts 64 hex characters", () => {
    expect(
      confirmSignupSchema.safeParse({ token: "a".repeat(64) }).success,
    ).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["a".repeat(63), "too short"],
    ["a".repeat(65), "too long"],
    ["g".repeat(64), "not hex"],
    ["A".repeat(64), "uppercase hex"],
  ])("rejects %s (%s)", (token) => {
    expect(confirmSignupSchema.safeParse({ token }).success).toBe(false);
  });
});
