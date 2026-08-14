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
 *   POST   /platform/tenants/:slug/retry-provisioning  PLATFORM_ADMIN
 *
 *   POST   /platform/licenses          PLATFORM_SALES+ (issue)
 *   GET    /platform/tenants/:slug/licenses  PLATFORM_SALES+ (history)
 *   POST   /platform/licenses/:jti/revoke    PLATFORM_ADMIN
 *
 *   GET    /platform/audit             PLATFORM_ADMIN
 *                                       (?tenantSlug=&action=&limit=)
 *
 * Auth: a dedicated preHandler that requires the JWT carry
 * `platform: true`. Tenant-side JWTs are rejected here, and the
 * reciprocal check lives in `app.authenticate` (libs/auth/src/plugin.ts)
 * — a `platform: true` token gets a 401 on every tenant route, so the
 * only way vendor staff reach tenant data is the audited
 * /platform/tenants/:slug/impersonate flow below.
 *
 * Note on the JWT instance: we re-use the Fastify `@fastify/jwt`
 * plugin already registered by `fastifyAuth`. Both tenant and
 * platform tokens are signed with the same JWT_SECRET; the
 * discriminator is the `platform: true` claim in the body.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { PlatformController } from "./platform.controller";
import { PlatformService, type PlatformJwtPayload } from "./platform.service";
import {
  impersonateResponseSchema,
  impersonateTenantSchema,
  issueLicenseResponseSchema,
  issueLicenseSchema,
  licenseJtiParamSchema,
  platformAuditQuerySchema,
  platformAuditResponseSchema,
  platformLoginResponseSchema,
  platformLoginSchema,
  platformMeResponseSchema,
  provisionTenantResponseSchema,
  provisionTenantSchema,
  retryProvisioningResponseSchema,
  revokeLicenseResponseSchema,
  tenantLicenseListResponseSchema,
  tenantListResponseSchema,
  tenantResponseSchema,
  tenantSlugParamSchema,
} from "./schemas";

const TAGS = ["platform"];

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
      Partial<PlatformJwtPayload> | undefined;
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
  // Login is public — no preHandler, and therefore no 401→400 hazard
  // from attaching a body schema: there is no auth here to be late.
  app.post(
    "/auth/login",
    {
      schema: routeSchema({
        summary:
          "Exchange platform credentials for a platform JWT. Public. " +
          "The token carries `platform: true`; tenant routes reject it, " +
          "and a tenant token is rejected everywhere below.",
        tags: TAGS,
        body: platformLoginSchema,
        response: platformLoginResponseSchema,
        errors: [400, 401],
      }),
    },
    ctrl.login,
  );

  // Everything below requires a verified platform JWT.
  app.register(async (scoped) => {
    /*
     * `onRequest`, not `preHandler`.
     *
     * Fastify validates the request between these two stages, so with
     * this hook at `preHandler` — where it sat until these routes were
     * documented — an anonymous caller sending a malformed body would
     * have been answered 400 with a description of the vendor control
     * plane's request shapes. On the surface that mints impersonation
     * tokens and issues licences, telling an unauthenticated stranger
     * what a valid request looks like is the wrong failure. `onRequest`
     * runs ahead of validation, so 401 still wins.
     *
     * `requirePlatformRole` stays a per-route `preHandler`: it reads
     * `req.user`, which this hook populates, so it must run after.
     */
    scoped.addHook("onRequest", platformAuthenticate);

    // /me — useful for the UI to confirm session validity + display
    // current user info without an extra DB hit.
    scoped.get(
      "/me",
      {
        schema: routeSchema({
          summary:
            "The calling platform user, read from the JWT — no database " +
            "hit. Carries no `name`, unlike the login response, because " +
            "the token does not hold one.",
          tags: TAGS,
          response: platformMeResponseSchema,
          errors: [401],
        }),
      },
      async (req) => {
        const payload = req.user as unknown as PlatformJwtPayload;
        return {
          id: payload.sub,
          email: payload.email,
          role: payload.role,
        };
      },
    );

    // ─── tenants ────────────────────────────────────────────────────
    scoped.get(
      "/tenants",
      {
        schema: routeSchema({
          summary: "Every tenant, newest first. PLATFORM_SALES and above.",
          tags: TAGS,
          response: tenantListResponseSchema,
          errors: [401, 403],
        }),
      },
      ctrl.listTenants,
    );
    scoped.get<{ Params: { slug: string } }>(
      "/tenants/:slug",
      {
        schema: routeSchema({
          summary: "One tenant by slug. PLATFORM_SALES and above.",
          tags: TAGS,
          params: tenantSlugParamSchema,
          response: tenantResponseSchema,
          errors: [401, 403, 404],
        }),
      },
      ctrl.findTenant,
    );

    scoped.post(
      "/tenants",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "Provision a tenant — creates its Postgres schema, runs " +
            "every migration and seeds an admin. Answers a NARROWED " +
            "row plus `bootstrapPassword`, which is shown once and " +
            "never again. 409 if the slug is taken.",
          tags: TAGS,
          body: provisionTenantSchema,
          response: provisionTenantResponseSchema,
          status: 201,
          errors: [400, 401, 403, 409],
        }),
      },
      ctrl.provisionTenant,
    );
    scoped.post<{ Params: { slug: string } }>(
      "/tenants/:slug/suspend",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "Suspend a tenant. Its users get 503 until restored. Takes " +
            "no body; answers the updated tenant row.",
          tags: TAGS,
          params: tenantSlugParamSchema,
          response: tenantResponseSchema,
          errors: [401, 403, 404],
        }),
      },
      ctrl.suspendTenant,
    );
    scoped.post<{ Params: { slug: string } }>(
      "/tenants/:slug/restore",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "Lift a suspension. Takes no body; answers the updated " +
            "tenant row.",
          tags: TAGS,
          params: tenantSlugParamSchema,
          response: tenantResponseSchema,
          errors: [401, 403, 404],
        }),
      },
      ctrl.restoreTenant,
    );
    scoped.post<{ Params: { slug: string } }>(
      "/tenants/:slug/archive",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "Archive a tenant. Terminal — the schema is retained but " +
            "the tenant stops serving and cannot be restored. Takes no " +
            "body; answers the updated tenant row.",
          tags: TAGS,
          params: tenantSlugParamSchema,
          response: tenantResponseSchema,
          errors: [401, 403, 404],
        }),
      },
      ctrl.archiveTenant,
    );
    /*
     * No `body` schema on retry-provisioning, deliberately. The handler
     * reads `req.body ?? {}` and never parses it — both fields are
     * optional — so a bodyless retry is the normal call and attaching a
     * schema would reject it with `body must be object`.
     */
    scoped.post<{
      Params: { slug: string };
      Body: { adminEmail?: string; adminName?: string };
    }>(
      "/tenants/:slug/retry-provisioning",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "Re-run provisioning for a tenant stuck in PROVISIONING. " +
            "Body is optional (`adminEmail`, `adminName`) and left " +
            "undeclared so the bodyless call keeps working. 409 if the " +
            "tenant is not in PROVISIONING.",
          tags: TAGS,
          params: tenantSlugParamSchema,
          response: retryProvisioningResponseSchema,
          errors: [400, 401, 403, 404, 409],
        }),
      },
      ctrl.retryProvisioning,
    );

    // ─── support: impersonate-tenant ─────────────────────────────────
    // Vendor-side support tooling. PLATFORM_ADMIN only — destructive
    // surface area + JWT mint is too sensitive for SALES. Each call
    // mints a short-lived tenant JWT and audit-logs on both sides.
    scoped.post<{ Params: { slug: string } }>(
      "/tenants/:slug/impersonate",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "Mint a short-lived TENANT token for support work, audited " +
            "on both sides. `purpose` is required — the audit trail is " +
            "the point. Staff users only; impersonating a borrower is " +
            "refused with 400. `expiresAt` is an ISO timestamp.",
          tags: TAGS,
          params: tenantSlugParamSchema,
          body: impersonateTenantSchema,
          response: impersonateResponseSchema,
          errors: [400, 401, 403, 404, 409],
        }),
      },
      ctrl.impersonateTenant,
    );

    // ─── licenses ────────────────────────────────────────────────────
    // SALES can issue (that's their primary tool). ADMIN inherits.
    scoped.post(
      "/licenses",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN", "PLATFORM_SALES"),
        schema: routeSchema({
          summary:
            "Issue a signed licence. The tenant need not exist yet — " +
            "issuance can precede provisioning. `iat`/`nbf`/`exp` in " +
            "the payload are unix MILLISECONDS, not ISO strings.",
          tags: TAGS,
          body: issueLicenseSchema,
          response: issueLicenseResponseSchema,
          status: 201,
          errors: [400, 401, 403],
        }),
      },
      ctrl.issueLicense,
    );

    // Per-tenant license history. SALES can view (it informs the
    // "should I renew?" conversation with the tenant); revoke is
    // ADMIN-only since it has downstream effects on the tenant.
    scoped.get<{ Params: { slug: string } }>(
      "/tenants/:slug/licenses",
      {
        schema: routeSchema({
          summary:
            "Licence history for one tenant, newest first. Each row " +
            "carries the full signed `token`, so a licence can be " +
            "resent without re-issuing it.",
          tags: TAGS,
          params: tenantSlugParamSchema,
          response: tenantLicenseListResponseSchema,
          errors: [401, 403],
        }),
      },
      ctrl.listTenantLicenses,
    );
    /*
     * No `body` schema on revoke. The handler parses `req.body ?? {}`
     * against an all-optional schema, so a bodyless revoke is legal and
     * attaching the schema would turn it into a 400.
     */
    scoped.post<{ Params: { jti: string } }>(
      "/licenses/:jti/revoke",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "Revoke an issued licence by its `jti`. Optional `reason` " +
            "in the body, left undeclared so the bodyless call keeps " +
            "working. `clearedSnapshot` says whether the tenant's " +
            "cached licence was wiped too. 409 if already revoked.",
          tags: TAGS,
          params: licenseJtiParamSchema,
          response: revokeLicenseResponseSchema,
          errors: [400, 401, 403, 404, 409],
        }),
      },
      ctrl.revokeLicense,
    );

    // ─── audit ───────────────────────────────────────────────────────
    scoped.get<{
      Querystring: { limit?: string; tenantSlug?: string; action?: string };
    }>(
      "/audit",
      {
        preHandler: requirePlatformRole("PLATFORM_ADMIN"),
        schema: routeSchema({
          summary:
            "The vendor-side audit trail — what platform staff did. " +
            "Distinct from the tenant `/audit` feed and a different " +
            "shape. `limit` defaults to 100 and is capped at 500.",
          tags: TAGS,
          querystring: platformAuditQuerySchema,
          response: platformAuditResponseSchema,
          errors: [400, 401, 403],
        }),
      },
      ctrl.listAudit,
    );
  });
}
