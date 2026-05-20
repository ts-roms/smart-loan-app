import { fastifyAuth } from '@loan/auth';
import { fastifyPrisma, resolveEffectivePermissions } from '@loan/db';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { registerRoutes } from './routes/index.js';

const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://loan:loan@localhost:5432/smart_loan',
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  SENTRY_DSN: process.env.SENTRY_DSN ?? '',
  NODE_ENV: process.env.NODE_ENV ?? 'development',
};

/**
 * Sentry is opt-in via SENTRY_DSN — keeping the dep skin-deep so local
 * dev doesn't try to ship events anywhere. When the DSN is set, every
 * unhandled error caught by Fastify is forwarded to Sentry with the
 * request's route, method, and the user id (if authenticated).
 */
async function initSentry() {
  if (!env.SENTRY_DSN) return null;
  const Sentry = await import('@sentry/node');
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
  });
  return Sentry;
}

export async function buildApp() {
  // Initialize Sentry before Fastify so it can hook into the global error
  // handlers. No-op when SENTRY_DSN isn't set.
  const sentry = await initSentry();

  const app = Fastify({
    logger: {
      transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
    },
  });

  if (sentry) {
    app.setErrorHandler((err, req, reply) => {
      // Don't ship validation/expected 4xx noise to Sentry — only the
      // genuine 5xx-class problems are useful signal.
      if (!err.statusCode || err.statusCode >= 500) {
        sentry.captureException(err, (scope) => {
          scope.setTag('route', req.routerPath ?? req.url);
          scope.setTag('method', req.method);
          const sub = (req.user as { sub?: string } | undefined)?.sub;
          if (sub) scope.setUser({ id: sub });
          return scope;
        });
      }
      reply.send(err);
    });
  }

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

  // Global rate limit is intentionally generous — the real protection is
  // the tight per-route limit on /auth/login (applied via { config: { rateLimit: ... } }
  // inside the auth route definitions). Adjust for production traffic.
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // Skip rate limiting for the healthcheck — k8s probes shouldn't get 429s.
    allowList: (req) => req.url === '/api/v1/health',
  });
  await app.register(fastifyPrisma, { databaseUrl: env.DATABASE_URL });
  // Inject the permission resolver — bridges @loan/auth (no prisma dep)
  // to @loan/db (where the schema + RBAC tables live). The resolver also
  // includes active delegations so the delegate's effective permission set
  // is the union of (their own roles ∪ delegated permissions).
  await app.register(fastifyAuth, {
    secret: env.JWT_SECRET,
    resolvePermissions: async (userId: string) => {
      const { permissions } = await resolveEffectivePermissions(app.prisma, userId);
      return permissions;
    },
  });

  // Static uploads: KYC documents, customer ID scans, etc.
  const uploadsDir = process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads');
  await mkdir(uploadsDir, { recursive: true });
  await app.register(staticPlugin, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Smart Loan API', version: '0.1.0' },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(registerRoutes, { prefix: '/api/v1' });

  return app;
}
