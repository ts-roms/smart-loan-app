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

import { fastifyAuth } from "./plugin";
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
