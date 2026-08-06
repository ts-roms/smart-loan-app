/**
 * The auth plugin — `authenticate`, `requirePermission`, `requireRole`.
 *
 * Driven through a real Fastify instance with the real @fastify/jwt, using
 * `inject` rather than mocks: these guards are only meaningful in terms of
 * the status code an unauthorized caller actually receives, and a mocked
 * `jwtVerify` would prove nothing about the plugin's wiring.
 *
 * The properties that matter are the negative ones. Every assertion below
 * that expects a 401 or 403 is guarding a path where failing *open* would
 * expose a lending system's data.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fastifyAuth, type SessionStatus } from "./plugin";
import type { JwtPayload } from "./types";

const SECRET = "test-secret-not-used-anywhere-real";

/**
 * Build an app with the real plugin and a handful of routes covering each
 * guard. `resolvePermissions` is a spy so we can assert on caching and on
 * the request being forwarded for tenant scoping.
 */
async function buildApp(perms: string[] = [], tenantPrisma?: unknown) {
  // Declared with the real parameter list so `mock.calls` is typed — the
  // tenant-scoping assertions below read the second argument.
  const resolvePermissions = vi.fn(
    async (_userId: string, _tenantPrisma?: unknown) => new Set(perms),
  );
  const app: FastifyInstance = Fastify();

  await app.register(fastifyAuth, { secret: SECRET, resolvePermissions });

  // Stand in for the multi-tenant plugin's preHandler. Must be registered
  // before `ready()`, so it's wired here rather than bolted on per test.
  if (tenantPrisma !== undefined) {
    app.addHook("onRequest", async (req) => {
      (req as { tenantCtx?: unknown }).tenantCtx = { prisma: tenantPrisma };
    });
  }

  app.get("/open", async () => ({ ok: true }));
  app.get("/authed", { preHandler: app.authenticate }, async (req) => ({
    sub: (req.user as { sub?: string }).sub,
  }));
  app.get(
    "/needs-read",
    { preHandler: [app.authenticate, app.requirePermission("customers.read")] },
    async () => ({ ok: true }),
  );
  app.get(
    "/needs-either",
    {
      preHandler: [
        app.authenticate,
        app.requirePermission("customers.read", "customers.write"),
      ],
    },
    async () => ({ ok: true }),
  );
  app.get(
    "/needs-admin-role",
    { preHandler: [app.authenticate, app.requireRole("ADMIN")] },
    async () => ({ ok: true }),
  );

  await app.ready();
  return { app, resolvePermissions };
}

/**
 * `app.jwt.sign` is typed to the app's own JwtPayload. Several tests here
 * deliberately mint payloads that aren't valid tenant tokens — a platform
 * token, an attacker's forgery — so the cast is the point rather than a
 * shortcut: it's how we get an invalid token past the type system and in
 * front of the guard, which is exactly what a real attacker would send.
 */
function bearer(app: FastifyInstance, payload: Record<string, unknown>) {
  return `Bearer ${app.jwt.sign(payload as unknown as JwtPayload)}`;
}

/**
 * A token with no `iat` at all. Nothing this app signs looks like this
 * — `noTimestamp` is the only way to produce one — which is the point:
 * it stands in for a malformed or hand-rolled token reaching the
 * revocation check, where the absence of a timestamp must not be read
 * as "issued recently".
 */
function bearerNoIat(app: FastifyInstance, payload: Record<string, unknown>) {
  return `Bearer ${app.jwt.sign(payload as unknown as JwtPayload, {
    noTimestamp: true,
  })}`;
}

const tenantUser: Record<string, unknown> = {
  sub: "user-1",
  email: "officer@example.test",
  role: "LOAN_OFFICER",
  tenant: "acme",
};

describe("authenticate", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  it("lets an unguarded route through without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/open" });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a missing token", async () => {
    const res = await app.inject({ method: "GET", url: "/authed" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a malformed token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const other = Fastify();
    await other.register(fastifyAuth, {
      secret: "a-different-secret",
      resolvePermissions: async () => new Set(),
    });
    await other.ready();
    const foreign = other.jwt.sign(tenantUser as unknown as JwtPayload);

    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: `Bearer ${foreign}` },
    });
    expect(res.statusCode).toBe(401);
    await other.close();
  });

  it("rejects an alg:none forgery", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "attacker", role: "ADMIN" }),
    ).toString("base64url");
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: `Bearer ${header}.${body}.` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid tenant token and exposes the claims", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tenantUser) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sub: "user-1" });
  });

  /**
   * Platform (control-plane) tokens are signed with the same secret as
   * tenant tokens, so signature verification alone cannot tell them apart —
   * only the `platform: true` claim does. Vendor access to tenant data is
   * supposed to go through the impersonation flow, which is TTL-bounded and
   * audited on both sides; a platform token reaching a tenant route
   * bypasses that entirely.
   */
  it("rejects a platform token on tenant routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: {
        authorization: bearer(app, {
          sub: "platform-admin",
          role: "PLATFORM_ADMIN",
          platform: true,
        }),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/platform/i);
  });

  it("does not reject on a merely falsy platform claim", async () => {
    // Only `platform === true` is a control-plane token. A tenant token that
    // happens to carry `platform: false` must still work.
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: {
        authorization: bearer(app, { ...tenantUser, platform: false }),
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("requirePermission", () => {
  it("401s when there is no token at all", async () => {
    const { app } = await buildApp(["customers.read"]);
    const res = await app.inject({ method: "GET", url: "/needs-read" });
    // Unauthenticated must not be reported as 403 — that would tell a
    // caller the route exists and their token was merely insufficient.
    expect(res.statusCode).toBe(401);
  });

  it("403s when the permission is absent", async () => {
    const { app } = await buildApp(["loans.read"]);
    const res = await app.inject({
      method: "GET",
      url: "/needs-read",
      headers: { authorization: bearer(app, tenantUser) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/customers\.read/);
  });

  it("403s when the caller holds no permissions at all", async () => {
    const { app } = await buildApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/needs-read",
      headers: { authorization: bearer(app, tenantUser) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows the request when the permission is present", async () => {
    const { app } = await buildApp(["customers.read"]);
    const res = await app.inject({
      method: "GET",
      url: "/needs-read",
      headers: { authorization: bearer(app, tenantUser) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("treats multiple keys as OR, not AND", async () => {
    const { app } = await buildApp(["customers.write"]);
    const res = await app.inject({
      method: "GET",
      url: "/needs-either",
      headers: { authorization: bearer(app, tenantUser) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("resolves permissions once per request, not once per guard", async () => {
    const { app, resolvePermissions } = await buildApp(["customers.read"]);
    await app.inject({
      method: "GET",
      url: "/needs-read",
      headers: { authorization: bearer(app, tenantUser) },
    });
    expect(resolvePermissions).toHaveBeenCalledTimes(1);
  });

  /**
   * Tenant scoping. User / Role / UserRoleAssignment live in each tenant's
   * own schema, so the resolver has to run against that tenant's client. The
   * plugin lifts it off `req.tenantCtx.prisma` and hands it over as the
   * second argument; when tenant resolution hasn't run it passes undefined
   * and the caller falls back to its default client.
   *
   * Getting this wrong is what made MULTI_TENANT=true unusable before —
   * resolving against the public schema finds no roles and denies every
   * gated route.
   */
  it("passes the tenant-bound client through to the resolver", async () => {
    const tenantPrisma = { __brand: "tenant-acme" };
    const { app, resolvePermissions } = await buildApp(
      ["customers.read"],
      tenantPrisma,
    );

    await app.inject({
      method: "GET",
      url: "/needs-read",
      headers: { authorization: bearer(app, tenantUser) },
    });

    const [userId, client] = resolvePermissions.mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(client).toBe(tenantPrisma);
  });

  it("passes undefined when tenant resolution has not run", async () => {
    // Single-tenant mode never sets tenantCtx here; the resolver is expected
    // to fall back rather than throw.
    const { app, resolvePermissions } = await buildApp(["customers.read"]);
    await app.inject({
      method: "GET",
      url: "/needs-read",
      headers: { authorization: bearer(app, tenantUser) },
    });
    const [userId, client] = resolvePermissions.mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(client).toBeUndefined();
  });

  it("does not resolve permissions for an unauthenticated caller", async () => {
    const { app, resolvePermissions } = await buildApp(["customers.read"]);
    await app.inject({ method: "GET", url: "/needs-read" });
    expect(resolvePermissions).not.toHaveBeenCalled();
  });
});

describe("requireRole", () => {
  it("403s a role that is not in the allowed list", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/needs-admin-role",
      headers: { authorization: bearer(app, tenantUser) },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows a matching role", async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/needs-admin-role",
      headers: { authorization: bearer(app, { ...tenantUser, role: "ADMIN" }) },
    });
    expect(res.statusCode).toBe(200);
  });

  /**
   * `requireRole` reads the role from the JWT, so it cannot see a role that
   * was revoked after the token was issued — the claim stays valid until
   * expiry. `requirePermission` re-resolves from the database on every
   * request and does not have this problem, which is why the route layer
   * uses it everywhere. Documented here so the difference is deliberate
   * rather than rediscovered.
   */
  it("trusts the JWT claim, so a revoked role survives until the token expires", async () => {
    const { app, resolvePermissions } = await buildApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/needs-admin-role",
      headers: { authorization: bearer(app, { ...tenantUser, role: "ADMIN" }) },
    });
    expect(res.statusCode).toBe(200);
    // No database lookup happened — that's the staleness this documents.
    expect(resolvePermissions).not.toHaveBeenCalled();
  });
});

/**
 * Session revocation — the enforcement half of "force logout".
 *
 * This is the only point in the request path where an access token is
 * checked against anything other than its own signature, so these tests
 * decide whether force-logout is a real control or a button that lies.
 * Every case below expecting a 401 guards an outcome where an admin was
 * told someone had been cut off.
 *
 * Tokens carry an explicit `iat` rather than relying on the signer's
 * clock: the whole mechanism is a comparison against that number, and a
 * test that cannot place a token in time cannot test it.
 */
async function buildSessionApp(status: SessionStatus | null) {
  const resolveSessionStatus = vi.fn(
    async (_userId: string, _tenantPrisma?: unknown) => status,
  );
  const app: FastifyInstance = Fastify();
  await app.register(fastifyAuth, {
    secret: SECRET,
    resolvePermissions: async () => new Set(["customers.read"]),
    resolveSessionStatus,
  });
  app.get("/authed", { preHandler: app.authenticate }, async () => ({
    ok: true,
  }));
  await app.ready();
  return { app, resolveSessionStatus };
}

/** Seconds since epoch — the unit `iat` is in. */
const SEC = 1_800_000_000;
const tokenIssuedAt = (secs: number) => ({ ...tenantUser, iat: secs });
const live: SessionStatus = { active: true, sessionsRevokedAtMs: null };

describe("session revocation", () => {
  it("lets a normal session through", async () => {
    const { app } = await buildSessionApp(live);
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC)) },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a token issued before the revocation", async () => {
    const { app } = await buildSessionApp({
      active: true,
      sessionsRevokedAtMs: SEC * 1000 + 5_000,
    });
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC)) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/session was ended/i);
  });

  /**
   * The point of the whole feature: a token minted AFTER the cutoff is
   * the user signing back in, and it has to work. If this fails, force
   * logout is indistinguishable from disabling the account.
   */
  it("accepts a token issued after the revocation", async () => {
    const { app } = await buildSessionApp({
      active: true,
      sessionsRevokedAtMs: SEC * 1000,
    });
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC + 1)) },
    });
    expect(res.statusCode).toBe(200);
  });

  /**
   * `iat` is whole seconds and the cutoff is milliseconds, so a token
   * minted during the same second as the revocation is ambiguous. It
   * has to resolve as revoked: rounding the other way lets a token live
   * its full 24 hours past a cutoff an admin believed had taken effect.
   */
  it("treats the same second as revoked, not as surviving", async () => {
    const { app } = await buildSessionApp({
      active: true,
      // 700ms into the same second the token claims.
      sessionsRevokedAtMs: SEC * 1000 + 700,
    });
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC)) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an undatable token when a revocation exists", async () => {
    // `noIat: true` suppresses the claim in the signer below. A token
    // that cannot be placed in time cannot be shown to post-date the
    // cutoff, and must not outrank it.
    const { app } = await buildSessionApp({
      active: true,
      sessionsRevokedAtMs: SEC * 1000,
    });
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearerNoIat(app, tenantUser) },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * The gap this closes alongside force-logout: `active` was enforced
   * at login and at refresh but nowhere in between, so disabling an
   * account left it working for the life of its access token.
   */
  it("rejects a disabled account mid-session", async () => {
    const { app } = await buildSessionApp({
      active: false,
      sessionsRevokedAtMs: null,
    });
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC)) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/disabled/i);
  });

  it("says something different for disabled than for ended", async () => {
    // They mean different things to the person reading them: one is
    // "sign in again", the other is "call your administrator".
    const { app: ended } = await buildSessionApp({
      active: true,
      sessionsRevokedAtMs: SEC * 1000 + 1,
    });
    const endedRes = await ended.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(ended, tokenIssuedAt(SEC)) },
    });
    const { app: disabled } = await buildSessionApp({
      active: false,
      sessionsRevokedAtMs: null,
    });
    const disabledRes = await disabled.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(disabled, tokenIssuedAt(SEC)) },
    });
    expect(endedRes.json().message).not.toBe(disabledRes.json().message);
  });

  it("rejects a token for a user who no longer exists", async () => {
    // Deleted mid-session, or minted against another tenant's schema.
    // A missing row must read as "not authenticated", never as "no
    // constraints found".
    const { app } = await buildSessionApp(null);
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC)) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("does not hit the database for an unauthenticated caller", async () => {
    const { app, resolveSessionStatus } = await buildSessionApp(live);
    await app.inject({ method: "GET", url: "/authed" });
    expect(resolveSessionStatus).not.toHaveBeenCalled();
  });

  it("passes the tenant-bound client through", async () => {
    // Same reasoning as the permission resolver: User lives in the
    // tenant's schema. Reading the wrong one finds nobody, which this
    // plugin treats as reject — so a mistake fails closed, but it fails
    // closed for every request the tenant makes.
    const tenantPrisma = { __brand: "tenant-acme" };
    const resolveSessionStatus = vi.fn(
      async (_userId: string, _tenantPrisma?: unknown) => live,
    );
    const app: FastifyInstance = Fastify();
    await app.register(fastifyAuth, {
      secret: SECRET,
      resolvePermissions: async () => new Set(),
      resolveSessionStatus,
    });
    app.addHook("onRequest", async (req) => {
      (req as { tenantCtx?: unknown }).tenantCtx = { prisma: tenantPrisma };
    });
    app.get("/authed", { preHandler: app.authenticate }, async () => ({
      ok: true,
    }));
    await app.ready();

    await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC)) },
    });
    const [userId, client] = resolveSessionStatus.mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(client).toBe(tenantPrisma);
    await app.close();
  });

  /**
   * Registering without the resolver degrades to a signature check.
   * Every other test in this file does exactly that, which is why the
   * option is optional — but it means an API that forgets to pass it
   * has no force-logout at all and no error saying so. Pinned here so
   * the degradation is a known shape rather than a production
   * discovery.
   */
  it("degrades to a signature check when no resolver is supplied", async () => {
    const { app } = await buildApp([]);
    const res = await app.inject({
      method: "GET",
      url: "/authed",
      headers: { authorization: bearer(app, tokenIssuedAt(SEC)) },
    });
    expect(res.statusCode).toBe(200);
  });
});
