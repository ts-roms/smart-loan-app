/**
 * The one place a Fastify request is turned into §56 audit provenance.
 *
 * `AuditLogRepository` lives in `libs/db`, which has no Fastify
 * dependency and is not getting one — so `req.ip`, the user agent and
 * the request id cannot be read where the row is written. They are
 * extracted here instead, into the plain `AuditRequestContext` shape
 * that libs/db understands, and handed to the repository's constructor
 * by the same per-request wiring that already supplies the impersonator.
 *
 * Keeping the extraction in one function rather than inline at each of
 * the two dozen construction sites is the point: `req.ip` vs
 * `req.socket.remoteAddress`, which header the user agent comes from,
 * and what the tenant id actually is are decisions that must not be
 * re-made (differently) per feature.
 *
 * @see libs/db/src/repositories/audit-log.repository.ts
 */

import {
  AuditLogRepository,
  LoginAttemptRepository,
  type AuditRequestContext,
  type PrismaClient,
} from "@loan/db";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";

/**
 * Extract the §56 provenance from a request.
 *
 * Safe to call before `resolveTenant` has run (`tenantCtx` is optional
 * here) — the auth routes record login attempts on requests that never
 * resolve a tenant, and a missing tenant must not throw on the audit
 * path.
 */
export function auditContextOf(req: FastifyRequest): AuditRequestContext {
  const userAgent = req.headers["user-agent"];
  return {
    // The tenant slug, not a UUID. Under schema-per-tenant the slug IS
    // the tenant's identity — it names the schema — and it is what every
    // other tenant-aware surface in this codebase (Sentry tags, the
    // migrate fan-out, the JWT claim) already uses.
    tenantId:
      (req as { tenantCtx?: { slug?: string } }).tenantCtx?.slug ?? null,
    // `req.ip` rather than the raw socket address: it honours Fastify's
    // trustProxy setting, so behind a load balancer this is the client's
    // address and not the balancer's. When trustProxy is off it falls
    // back to the socket address, which is the correct answer for a
    // directly-exposed deployment.
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(userAgent)
      ? (userAgent[0] ?? null)
      : (userAgent ?? null),
    // Seeded from an inbound X-Request-Id or a fresh UUID — see genReqId
    // in app.ts. Never the Fastify default counter.
    requestId: req.id ?? null,
  };
}

/**
 * Build a fully-populated audit repository for a request.
 *
 * This is the constructor every route should use. It supplies all three
 * of the things a bare `new AuditLogRepository(prisma)` misses: the
 * impersonator, the §56 request context, and the pino logger that write
 * failures are reported through.
 *
 * @param prisma Defaults to `req.tenantCtx.prisma`. Pass explicitly only
 *               when the caller already holds the tenant client.
 */
export function auditFor(
  req: FastifyRequest,
  prisma?: PrismaClient,
): AuditLogRepository {
  return new AuditLogRepository(
    prisma ?? (req as { tenantCtx: { prisma: PrismaClient } }).tenantCtx.prisma,
    req.user?.impersonatedBy,
    { context: auditContextOf(req), logger: req.log as FastifyBaseLogger },
  );
}

/**
 * Build the login-attempt security log for a request.
 *
 * Separate from `auditFor` because it is used on the unauthenticated
 * path, where there is no `req.user` and often no resolved tenant — the
 * caller passes the Prisma client it managed to resolve.
 */
export function loginAttemptsFor(
  req: FastifyRequest,
  prisma: PrismaClient,
): LoginAttemptRepository {
  return new LoginAttemptRepository(prisma, {
    context: auditContextOf(req),
    logger: req.log as FastifyBaseLogger,
  });
}
