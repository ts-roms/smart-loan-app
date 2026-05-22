/**
 * Platform routes — /platform/*. The vendor's control plane.
 *
 *   POST   /platform/auth/login        public (issues platform JWT)
 *   GET    /platform/me                requires platform JWT
 *
 *   GET    /platform/tenants           PLATFORM_SALES+
 *   POST   /platform/tenants           PLATFORM_ADMIN (provision)
 *   GET    /platform/tenants/:slug     PLATFORM_SALES+
 *   POST   /platform/tenants/:slug/suspend  PLATFORM_ADMIN
 *   POST   /platform/tenants/:slug/restore  PLATFORM_ADMIN
 *   POST   /platform/tenants/:slug/archive  PLATFORM_ADMIN
 *
 *   POST   /platform/licenses          PLATFORM_SALES+ (issue)
 *
 *   GET    /platform/audit             PLATFORM_ADMIN
 *
 * Auth: a dedicated preHandler that requires the JWT carry
 * `platform: true`. Tenant-side JWTs are rejected (and vice-versa
 * on tenant routes — they reject `platform: true` claims).
 *
 * Note on the JWT instance: we re-use the Fastify `@fastify/jwt`
 * plugin already registered by `fastifyAuth`. Both tenant and
 * platform tokens are signed with the same JWT_SECRET; the
 * discriminator is the `platform: true` claim in the body.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { PlatformController } from "./platform.controller";
import { PlatformService, type PlatformJwtPayload } from "./platform.service";

export async function platformRoutes(app: FastifyInstance) {
  const service = new PlatformService(app.prisma, app, app.log);
  const ctrl = new PlatformController(service);

  // Seed a default PLATFORM_ADMIN on first boot so the operator has a
  // way in. The bootstrap creds come from env (with a documented
  // insecure default) — same pattern as the tenant-side admin seed.
  await service.seedDefaultAdminIfEmpty();

  /**
   * Platform-only authentication. Verifies the JWT and asserts the
   * `platform: true` claim is present. A tenant-side token (no
   * `platform` claim) gets a 401 here, so a stolen tenant token
   * can't escalate into platform actions.
   */
  const platformAuthenticate = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const payload = req.user as unknown as
      | Partial<PlatformJwtPayload>
      | undefined;
    if (!payload || payload.platform !== true) {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Platform JWT required.",
      });
    }
  };

  /**
   * Role gate within the platform — PLATFORM_ADMIN can do everything,
   * PLATFORM_SALES is view + license issuance only.
   */
  const requirePlatformRole =
    (...roles: Array<"PLATFORM_ADMIN" | "PLATFORM_SALES">) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const payload = req.user as unknown as PlatformJwtPayload;
      if (!roles.includes(payload.role)) {
        return reply.code(403).send({
          error: "Forbidden",
          message: `Requires ${roles.join(" or ")}.`,
        });
      }
    };

  // ─── auth ──────────────────────────────────────────────────────────
  // Login is public — no preHandler.
  app.post("/auth/login", ctrl.login);

  // Everything below requires a verified platform JWT.
  app.register(async (scoped) => {
    scoped.addHook("preHandler", platformAuthenticate);

    // /me — useful for the UI to confirm session validity + display
    // current user info without an extra DB hit.
    scoped.get("/me", async (req) => {
      const payload = req.user as unknown as PlatformJwtPayload;
      return {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };
    });

    // ─── tenants ────────────────────────────────────────────────────
    scoped.get("/tenants", ctrl.listTenants);
    scoped.get<{ Params: { slug: string } }>("/tenants/:slug", ctrl.findTenant);

    scoped.post(
      "/tenants",
      { preHandler: requirePlatformRole("PLATFORM_ADMIN") },
      ctrl.provisionTenant,
    );
    scoped.post<{ Params: { slug: string } }>(
      "/tenants/:slug/suspend",
      { preHandler: requirePlatformRole("PLATFORM_ADMIN") },
      ctrl.suspendTenant,
    );
    scoped.post<{ Params: { slug: string } }>(
      "/tenants/:slug/restore",
      { preHandler: requirePlatformRole("PLATFORM_ADMIN") },
      ctrl.restoreTenant,
    );
    scoped.post<{ Params: { slug: string } }>(
      "/tenants/:slug/archive",
      { preHandler: requirePlatformRole("PLATFORM_ADMIN") },
      ctrl.archiveTenant,
    );

    // ─── licenses ────────────────────────────────────────────────────
    // SALES can issue (that's their primary tool). ADMIN inherits.
    scoped.post(
      "/licenses",
      { preHandler: requirePlatformRole("PLATFORM_ADMIN", "PLATFORM_SALES") },
      ctrl.issueLicense,
    );

    // ─── audit ───────────────────────────────────────────────────────
    scoped.get<{ Querystring: { limit?: string } }>(
      "/audit",
      { preHandler: requirePlatformRole("PLATFORM_ADMIN") },
      ctrl.listAudit,
    );
  });
}
