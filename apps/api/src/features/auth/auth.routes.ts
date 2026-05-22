import { AuditLogRepository, type PrismaClient } from "@loan/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config } from "../../config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

/**
 * Auth feature plugin. Owns every write path on /auth and every /me
 * read. Heavy layered split because every endpoint here is
 * security-critical and audit-coupled — see auth.service.ts for the
 * orchestration contracts.
 *
 * ## Phase 2 tenant resolution
 *
 * Auth is the one feature where tenant resolution is NOT a uniform
 * preHandler:
 *
 *   - **Authenticated routes** (`/me`, `/me/signature`, `/me/2fa/*`,
 *     `/me/permissions`, `/me/notifications/*`) — the JWT is verified
 *     by `app.authenticate` first, then `app.resolveTenant` reads the
 *     `tenant` claim and binds the per-request Prisma client.
 *
 *   - **Unauthenticated credential routes** (`/login`, `/register`,
 *     `/refresh`, `/logout`) — there's no JWT to read from, so the
 *     tenant slug comes from the request body. A dedicated
 *     `resolveTenantFromBody` preHandler handles that path, validating
 *     against the platform-side `Tenant` catalog before issuing the
 *     scoped client.
 *
 * In single-tenant mode (`config.multiTenant === false`) both paths
 * collapse to `app.prisma` + the default slug.
 */

declare module "fastify" {
  interface FastifyRequest {
    authServices?: { auth: AuthService };
  }
}

export async function authRoutes(app: FastifyInstance) {
  const auth = new AuthController();

  // Tight rate limit on credential endpoints — defends against
  // credential stuffing and account-enumeration probes. Keyed on IP
  // via the global rate-limit plugin's default keyGenerator.
  const authThrottle = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };

  // ── Public credential endpoints ────────────────────────────────────
  // These resolve the tenant from `req.body.tenantSlug`, NOT from a
  // JWT (which doesn't exist yet at login time). The
  // resolveTenantFromBody preHandler does that work and also builds
  // the per-request AuthService against the resolved client.
  const publicPre = [resolveTenantFromBody(app), buildAuthService(app)];

  app.post("/login", { ...authThrottle, preHandler: publicPre }, auth.login);
  app.post(
    "/register",
    { ...authThrottle, preHandler: publicPre },
    auth.register,
  );
  app.post(
    "/refresh",
    { ...authThrottle, preHandler: publicPre },
    auth.refresh,
  );
  app.post("/logout", { preHandler: publicPre }, auth.logout);

  // ── Authenticated routes ───────────────────────────────────────────
  // app.authenticate verifies the JWT → req.user is set with the
  // tenant claim. app.resolveTenant reads it and binds req.tenantCtx.
  // buildAuthService then instantiates the per-request service.
  const authedPre = [
    app.authenticate,
    app.resolveTenant,
    buildAuthService(app),
  ];

  app.get("/me", { preHandler: authedPre }, auth.me);
  app.get("/me/signature", { preHandler: authedPre }, auth.getSignature);
  app.put("/me/signature", { preHandler: authedPre }, auth.setSignature);
  app.delete("/me/signature", { preHandler: authedPre }, auth.clearSignature);
  app.get("/me/permissions", { preHandler: authedPre }, auth.permissions);

  // Notification bell state
  app.get(
    "/me/notifications/state",
    { preHandler: authedPre },
    auth.notificationsState,
  );
  app.post(
    "/me/notifications/seen",
    { preHandler: authedPre },
    auth.markNotificationsSeen,
  );

  // 2FA (TOTP) — three-step setup flow + disable
  app.get("/me/2fa/status", { preHandler: authedPre }, auth.totpStatus);
  app.post("/me/2fa/setup", { preHandler: authedPre }, auth.totpSetup);
  app.post("/me/2fa/enable", { preHandler: authedPre }, auth.totpEnable);
  app.post("/me/2fa/disable", { preHandler: authedPre }, auth.totpDisable);
}

// ─── preHandlers ──────────────────────────────────────────────────────

/**
 * Read `tenantSlug` from the request body, validate against the
 * platform-side Tenant catalog, and populate `req.tenantCtx`. Used by
 * /login, /register, /refresh, /logout — the routes that don't have
 * a verified JWT yet.
 *
 * In single-tenant mode this short-circuits to the default slug and
 * `app.prisma`; no Tenant lookup runs, so single-tenant deployments
 * don't need a Tenant row to exist at all.
 *
 * Validation strategy: on a missing-or-bad tenant we 401 with a
 * generic message (same shape login uses for bad creds). We don't
 * leak which slugs exist; an attacker probing `tenantSlug=acme` vs
 * `tenantSlug=ghost-corp` sees the same response.
 */
function resolveTenantFromBody(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.multiTenant) {
      req.tenantCtx = {
        slug: config.defaultTenantSlug,
        prisma: app.prisma,
      };
      return;
    }

    const body = (req.body ?? {}) as { tenantSlug?: unknown };
    const claim = body.tenantSlug;
    if (typeof claim !== "string" || !/^[a-z][a-z0-9-]+$/.test(claim)) {
      await reply.code(401).send({
        error: "Unauthorized",
        message: "Invalid credentials.",
      });
      return;
    }

    const tenant = await app.prisma.tenant.findUnique({
      where: { slug: claim },
      select: { status: true },
    });
    if (!tenant || tenant.status !== "ACTIVE") {
      // Same shape as a wrong-password reply — no enumeration.
      await reply.code(401).send({
        error: "Unauthorized",
        message: "Invalid credentials.",
      });
      return;
    }

    req.tenantCtx = {
      slug: claim,
      prisma: app.tenantPrisma.get(claim),
    };
  };
}

/**
 * Instantiate the per-request AuthService bound to the resolved
 * tenant Prisma client. Reads `req.tenantCtx` (set by one of the two
 * tenant resolvers above) and writes `req.authServices`.
 *
 * The service depends on prisma + an audit log repo + two Fastify-
 * decorated capabilities (jwt.sign + resolvePermissions). The
 * AuditLogRepository is constructed per-request because it captures
 * the prisma client — cheap (just a class instance) and keeps the
 * audit trail aligned with the tenant scope.
 */
function buildAuthService(app: FastifyInstance) {
  return async (req: FastifyRequest): Promise<void> => {
    const prisma: PrismaClient = req.tenantCtx.prisma;
    const audit = new AuditLogRepository(prisma);
    const service = new AuthService(
      prisma,
      audit,
      (payload, opts) => app.jwt.sign(payload, opts),
      (userId) => app.resolvePermissions(userId),
    );
    req.authServices = { auth: service };
  };
}
