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

/** What `authenticate` needs to know about the account behind a token. */
export interface SessionStatus {
  /** `User.active`. False → the account is disabled. */
  active: boolean;
  /**
   * `User.sessionsRevokedAt`, in epoch MILLISECONDS, or null when the
   * user has never been force-logged-out (almost every row).
   */
  sessionsRevokedAtMs: number | null;
}

/**
 * Looks up the live state of the account a token claims to be.
 *
 * Injected by the API for the same reason as `PermissionResolver`: this
 * package sits below @loan/db and can't see PrismaClient. Returns null
 * when the user row is gone, which must be treated as "not
 * authenticated" rather than as "no constraints".
 */
export type SessionStatusResolver = (
  userId: string,
  tenantPrisma?: unknown,
) => Promise<SessionStatus | null>;

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
  /**
   * Optional so the plugin's own unit tests can register it bare. In
   * the API it is always supplied — without it, `authenticate` degrades
   * to a signature check and force-logout stops working, so a
   * deployment that forgets it fails open. `createApp` passes it
   * unconditionally for that reason.
   */
  resolveSessionStatus?: SessionStatusResolver;
}

/**
 * Reject a token whose `iat` is at or before the revocation cutoff.
 *
 * `iat` is in whole seconds (RFC 7519) while the cutoff has millisecond
 * precision, so the comparison has to pick a side for a token minted
 * during the same second as the revocation. It picks revoked:
 *
 *   issued 10.2s, revoked 10.7s → iat 10 ≤ 10 → rejected (correct)
 *   issued 10.9s, revoked 10.7s → iat 10 ≤ 10 → rejected (early by 0.1s)
 *   issued 11.1s, revoked 10.7s → iat 11 > 10 → accepted (correct)
 *
 * The middle row is the cost: someone who signs in again inside the
 * same second as the revocation is bounced once and has to retry. The
 * alternative rounds the other way and lets a token minted just after
 * the cutoff live for its full 24 hours. For a control whose entire
 * purpose is "end this session now", failing closed on a sub-second
 * ambiguity is the only defensible direction.
 */
function issuedBeforeRevocation(
  iatSeconds: number | undefined,
  revokedAtMs: number | null,
): boolean {
  if (revokedAtMs === null) return false;
  // No `iat` means we can't place the token in time. Tokens this app
  // signs always carry one; anything else is malformed, and a token we
  // can't date must not outrank a revocation.
  if (typeof iatSeconds !== "number") return true;
  return iatSeconds <= Math.floor(revokedAtMs / 1000);
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

      /*
       * Everything above is stateless — it proves the token was signed
       * by us and hasn't expired, and nothing more. That was the whole
       * of authentication until now, and it had two holes:
       *
       *   - `User.active` was enforced at login and at refresh but
       *     never in between, so disabling an account left it working
       *     until its 24h access token ran out.
       *   - There was no way to end a session at all. Revoking refresh
       *     tokens does nothing to the access token already in hand.
       *
       * Both need the same thing: asking the database whether this
       * account is still allowed to be here.
       *
       * The cost is one indexed primary-key lookup per authenticated
       * request. Deliberately uncached. Every permission-gated route
       * already resolves the caller's permissions on each request — a
       * multi-table join — so this is strictly smaller than what the
       * same path already pays. A cache would trade a real correctness
       * property (revocation takes effect NOW) for a saving nobody has
       * shown is needed, and its staleness window would be a silent,
       * invisible weakening of the one guarantee the feature sells. If
       * profiling ever says otherwise, add it then, with the staleness
       * budget written down.
       */
      if (!opts.resolveSessionStatus) return;
      const payload = req.user as JwtPayload & { iat?: number };
      const status = await opts.resolveSessionStatus(
        payload.sub,
        tenantPrismaOf(req),
      );
      // A token for a user who no longer exists. Deleted mid-session,
      // or a token minted against another tenant's schema.
      if (!status) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", message: "Invalid or missing token" });
      }
      if (!status.active) {
        return reply.code(401).send({
          error: "Unauthorized",
          message: "This account has been disabled.",
        });
      }
      if (issuedBeforeRevocation(payload.iat, status.sessionsRevokedAtMs)) {
        // Named distinctly from the disabled case so the client can
        // tell "sign in again" from "call your administrator", and so
        // the person on the other end isn't told their account is gone
        // when it isn't.
        return reply.code(401).send({
          error: "Unauthorized",
          message: "Your session was ended. Please sign in again.",
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
