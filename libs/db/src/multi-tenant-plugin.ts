import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import { TenantPrismaCache } from "./tenant-cache";

/**
 * Multi-tenant resolution for schema-per-tenant deployments.
 *
 * Two modes, switched by the `MULTI_TENANT` env var:
 *
 *   - **Single-tenant** (default, `MULTI_TENANT !== "true"`):
 *     `req.tenantCtx.prisma` is just `app.prisma` (the public-schema
 *     client). Existing installations keep working unchanged. The
 *     decoration exists purely so feature code can be written in the
 *     "future" style without forking on env.
 *
 *   - **Multi-tenant** (`MULTI_TENANT=true`):
 *     - JWT must carry a `tenant` claim (the slug)
 *     - The slug is validated to match `/^[a-z][a-z0-9-]+$/` (same
 *       regex as the platform-side `tenantSlugSchema`)
 *     - The `Tenant` row is loaded; ACTIVE → proceed, anything else →
 *       503 with an actionable error
 *     - `req.tenantCtx.prisma` is a `PrismaClient` whose connections
 *       are bound to `tenant_<slug>` via `?schema=` in the URL
 *
 * The resolve preHandler MUST run after `app.authenticate` so the JWT
 * is verified before we trust the `tenant` claim. The plugin doesn't
 * register the preHandler globally — feature plugins opt in via
 * `app.addHook("preHandler", app.resolveTenant)` so platform routes
 * (which don't have a tenant context) can skip it.
 *
 * @see docs/multi-tenant-implementation.md
 */

export interface TenantContext {
  /** Tenant slug, e.g. "mt-banahaw" or "default" in single-tenant mode. */
  slug: string;
  /**
   * Prisma client bound to this tenant's schema. In single-tenant
   * mode, this is the shared `app.prisma`. In multi-tenant mode,
   * it's a per-tenant cached client whose pool has its
   * `search_path` set via `?schema=tenant_<slug>` in the DSN.
   */
  prisma: PrismaClient;
}

declare module "fastify" {
  interface FastifyInstance {
    tenantPrisma: TenantPrismaCache;
    resolveTenant: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    tenantCtx: TenantContext;
  }
}

/** Same regex as the platform schemas. SQL-safe characters only. */
const SLUG_RE = /^[a-z][a-z0-9-]+$/;

export interface MultiTenantPluginOptions {
  /**
   * Switches between modes. When false (default), single-tenant
   * fallback is used and the tenantPrisma cache is never populated.
   */
  multiTenant?: boolean;
  /** Slug returned in single-tenant mode. Default "default". */
  defaultSlug?: string;
  /** Base DATABASE_URL — schema overridden per tenant in multi-tenant mode. */
  databaseUrl: string;
  /** Per-tenant pool size. Default 3. */
  perTenantConnectionLimit?: number;
}

export const fastifyTenantPrisma = fp<MultiTenantPluginOptions>(
  async (app, opts) => {
    const multiTenant = opts.multiTenant === true;
    const defaultSlug = opts.defaultSlug ?? "default";

    const cache = new TenantPrismaCache({
      databaseUrl: opts.databaseUrl,
      perTenantConnectionLimit: opts.perTenantConnectionLimit,
    });
    app.decorate("tenantPrisma", cache);

    app.addHook("onClose", async () => {
      await cache.closeAll();
    });

    const resolveTenant = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> => {
      if (!multiTenant) {
        // Single-tenant: no JWT claim required, no Tenant row lookup,
        // no per-tenant client. Use the shared app.prisma so feature
        // code can adopt the new pattern without behavior change.
        req.tenantCtx = { slug: defaultSlug, prisma: app.prisma };
        return;
      }

      const claim = (req.user as { tenant?: unknown } | undefined)?.tenant;
      if (typeof claim !== "string" || !SLUG_RE.test(claim)) {
        await reply.code(401).send({
          error: "MissingTenantClaim",
          message:
            "JWT does not carry a valid `tenant` claim. Sign in with a tenant-scoped login.",
        });
        return;
      }

      // Look up the Tenant row to confirm it exists and is ACTIVE.
      // SUSPENDED tenants get a 503 so the frontend can show a
      // useful message; ARCHIVED is treated as not-found.
      const tenant = await app.prisma.tenant.findUnique({
        where: { slug: claim },
        select: { status: true },
      });
      if (!tenant || tenant.status === "ARCHIVED") {
        await reply.code(404).send({
          error: "TenantNotFound",
          message: `Tenant "${claim}" does not exist or has been archived.`,
        });
        return;
      }
      if (tenant.status === "PROVISIONING") {
        await reply.code(503).send({
          error: "TenantProvisioning",
          message: "Tenant is still being provisioned. Retry in a few seconds.",
        });
        return;
      }
      if (tenant.status === "SUSPENDED") {
        await reply.code(503).send({
          error: "TenantSuspended",
          message:
            "Tenant access is currently suspended. Contact the operator.",
        });
        return;
      }

      // Touch lastSeenAt — useful signal for "is this tenant actually
      // running?" in the platform console. Fire-and-forget; failure
      // here shouldn't 500 the request.
      app.prisma.tenant
        .update({
          where: { slug: claim },
          data: { lastSeenAt: new Date() },
        })
        .catch(() => {});

      req.tenantCtx = { slug: claim, prisma: cache.get(claim) };
    };

    app.decorate("resolveTenant", resolveTenant);
  },
  {
    name: "fastify-tenant-prisma",
    dependencies: ["fastify-prisma"],
  },
);
