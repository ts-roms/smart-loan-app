import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import type { JwtPayload, UserRole } from './types.js';

declare module 'fastify' {
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
    resolvePermissions: (userId: string) => Promise<Set<string>>;
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
  /**
   * Resolver injected by the API to avoid a circular @loan/auth ↔ @loan/db
   * dependency. Called per-request when permissions haven't been cached
   * on req yet.
   */
  resolvePermissions: (userId: string) => Promise<Set<string>>;
}

export const fastifyAuth = fp<Options>(async (app: FastifyInstance, opts) => {
  await app.register(jwt, { secret: opts.secret });

  app.decorate('resolvePermissions', opts.resolvePermissions);

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
    }
  });

  /**
   * Coarse role gate. Kept for backward compat — checks `User.role` from
   * the JWT against the allowed list. New code should prefer `requirePermission`.
   */
  app.decorate('requireRole', (...roles: UserRole[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const payload = req.user as JwtPayload | undefined;
      if (!payload || !roles.includes(payload.role)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient role' });
      }
    };
  });

  /**
   * Fine-grained permission gate. The user must hold at least one of the
   * supplied keys via any of their assigned roles. ADMIN is *not*
   * special-cased — set up the ADMIN role's permission set to include
   * everything if you want that.
   */
  app.decorate('requirePermission', (...keys: string[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const payload = req.user as JwtPayload | undefined;
      if (!payload) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      if (!req.permissions) {
        req.permissions = await opts.resolvePermissions(payload.sub);
      }
      const ok = keys.some((k) => req.permissions!.has(k));
      if (!ok) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: `Missing required permission: ${keys.join(' or ')}`,
        });
      }
    };
  });
});
