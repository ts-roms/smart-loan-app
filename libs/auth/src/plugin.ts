import jwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import type { JwtPayload, UserRole } from "./types";

/**
 * Resolver injected by the API to avoid a circular @loan/auth ↔ @loan/db
 * dependency.
 *
 * `tenantPrisma` is the caller's tenant-bound Prisma client
 * (`req.tenantCtx.prisma`). It's typed `unknown` here because this
 * package can't see `PrismaClient` — the API-side implementation casts
 * it back. When omitted the resolver falls back to the platform/public
 * client, which is only correct in single-tenant mode; every RBAC table
 * (User / Role / UserRoleAssignment / Delegation) lives in the tenant's
 * own schema, so resolving against `app.prisma` in multi-tenant mode
 * returns an empty set and denies everything.
 */
export type PermissionResolver = (
  userId: string,
  tenantPrisma?: unknown,
) => Promise<Set<string>>;

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: UserRole[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Permission-based gate. Pass one or more permission keys; the user
     * must have at least one of them via their assigned roles.
     */
    requirePermission: (
      ...keys: string[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Resolver function — same signature the @loan/db RBAC helper exposes. */
    resolvePermissions: PermissionResolver;
  }
  interface FastifyRequest {
    /**
     * Lazily-populated permission set for the current user. The middleware
     * reads from here when present; otherwise resolves via the plugin's
     * `resolvePermissions` callback.
     */
    permissions?: Set<string>;
  }
}

interface Options {
  secret: string;
  resolvePermissions: PermissionResolver;
}

/**
 * Read the tenant-bound Prisma client off the request without taking a
 * type dependency on @loan/db (which augments `FastifyRequest` with
 * `tenantCtx`). Undefined on routes that don't run `resolveTenant`.
 */
function tenantPrismaOf(req: FastifyRequest): unknown {
  return (req as { tenantCtx?: { prisma?: unknown } }).tenantCtx?.prisma;
}

export const fastifyAuth = fp<Options>(async (app: FastifyInstance, opts) => {
  await app.register(jwt, { secret: opts.secret });

  app.decorate("resolvePermissions", opts.resolvePermissions);

  app.decorate(
    "authenticate",
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply
          .code(401)
          .send({ error: "Unauthorized", message: "Invalid or missing token" });
      }
      // Platform (vendor control-plane) tokens are signed with the SAME
      // JWT_SECRET as tenant tokens — the only discriminator is the
      // `platform: true` claim. Without this check a platform token
      // satisfies `app.authenticate` and walks straight onto every
      // tenant route, bypassing the audited
      // /platform/tenants/:slug/impersonate flow that is supposed to be
      // the only way vendor staff touch tenant data. (Platform routes
      // run their own `platformAuthenticate`, which asserts the claim
      // is present — this is the reciprocal half that
      // features/platform/platform.routes.ts already documents.)
      const platformClaim = (req.user as { platform?: unknown } | undefined)
        ?.platform;
      if (platformClaim === true) {
        return reply.code(401).send({
          error: "Unauthorized",
          message:
            "Platform tokens cannot access tenant routes. Use /platform/tenants/:slug/impersonate.",
        });
      }
    },
  );

  /**
   * Coarse role gate. Kept for backward compat — checks `User.role` from
   * the JWT against the allowed list. New code should prefer `requirePermission`.
   */
  app.decorate("requireRole", (...roles: UserRole[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const payload = req.user as JwtPayload | undefined;
      if (!payload || !roles.includes(payload.role)) {
        return reply
          .code(403)
          .send({ error: "Forbidden", message: "Insufficient role" });
      }
    };
  });

  /**
   * Fine-grained permission gate. The user must hold at least one of the
   * supplied keys via any of their assigned roles. ADMIN is *not*
   * special-cased — set up the ADMIN role's permission set to include
   * everything if you want that.
   *
   * Resolution runs against `req.tenantCtx.prisma` so the RBAC tables
   * read are the calling tenant's, not the public schema's. That means
   * `requirePermission` must be sequenced AFTER `app.resolveTenant` —
   * which it always is, because features register `resolveTenant` as an
   * instance-level preHandler hook and Fastify runs those before the
   * per-route `preHandler` option.
   */
  app.decorate("requirePermission", (...keys: string[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const payload = req.user as JwtPayload | undefined;
      if (!payload) {
        return reply.code(401).send({ error: "Unauthorized" });
      }
      if (!req.permissions) {
        req.permissions = await opts.resolvePermissions(
          payload.sub,
          tenantPrismaOf(req),
        );
      }
      const ok = keys.some((k) => req.permissions!.has(k));
      if (!ok) {
        return reply.code(403).send({
          error: "Forbidden",
          message: `Missing required permission: ${keys.join(" or ")}`,
        });
      }
    };
  });
});
