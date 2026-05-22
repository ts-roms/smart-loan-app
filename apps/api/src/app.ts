import { fastifyAuth } from "@loan/auth";
import {
  fastifyPrisma,
  fastifyTenantPrisma,
  resolveEffectivePermissions,
} from "@loan/db";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { config } from "./config";
import { platformRoutes } from "./features/platform/index";
import { publicRoutes } from "./features/public/index";
import { registerRoutes } from "./routes/index";

/**
 * Sentry is opt-in via SENTRY_DSN — keeping the dep skin-deep so local
 * dev doesn't try to ship events anywhere. When the DSN is set, every
 * unhandled error caught by Fastify is forwarded to Sentry with the
 * request's route, method, and the user id (if authenticated).
 */
async function initSentry() {
  if (!config.sentryDsn) return null;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    tracesSampleRate: config.isProd ? 0.1 : 0,
  });
  return Sentry;
}

export async function buildApp() {
  // Initialize Sentry before Fastify so it can hook into the global error
  // handlers. No-op when SENTRY_DSN isn't set.
  const sentry = await initSentry();

  const app = Fastify({
    // In production we want structured JSON logs (log aggregators parse them
    // natively). Pretty output is dev-only — production runs cost cycles on
    // pino-pretty's transform and can't be parsed by log shippers.
    // Redact sensitive paths so JWTs / passwords / government IDs never
    // surface in logs (production audit + GDPR concern).
    logger: config.isProd
      ? {
          level: process.env.LOG_LEVEL ?? "info",
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.body.password",
              "req.body.refreshToken",
              "req.body.governmentIdNumber",
              "*.password",
              "*.token",
              "*.secret",
            ],
            censor: "[REDACTED]",
          },
        }
      : {
          transport: {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss" },
          },
        },
  });

  if (sentry) {
    app.setErrorHandler((err: FastifyError, req, reply) => {
      // Don't ship validation/expected 4xx noise to Sentry — only the
      // genuine 5xx-class problems are useful signal.
      if (!err.statusCode || err.statusCode >= 500) {
        sentry.captureException(err, (scope) => {
          // Fastify 5 dropped req.routerPath in favour of routeOptions.url;
          // we fall through to the raw request URL when the route hasn't
          // been resolved (e.g. 404s before routing).
          scope.setTag("route", req.routeOptions?.url ?? req.url);
          scope.setTag("method", req.method);
          const sub = (req.user as { sub?: string } | undefined)?.sub;
          if (sub) scope.setUser({ id: sub });
          return scope;
        });
      }
      reply.send(err);
    });
  }

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.webOrigin, credentials: true });
  await app.register(sensible);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

  // Global rate limit is intentionally generous — the real protection is
  // the tight per-route limit on /auth/login (applied via { config: { rateLimit: ... } }
  // inside the auth route definitions). Adjust for production traffic.
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    // Skip rate limiting for the healthcheck — k8s probes shouldn't get 429s.
    allowList: (req) => req.url === "/api/v1/health",
  });
  await app.register(fastifyPrisma, { databaseUrl: config.databaseUrl });
  // Multi-tenant resolution. In single-tenant mode (default) this is a
  // no-op preHandler that points req.tenantCtx.prisma at the shared
  // app.prisma. In multi-tenant mode it reads the JWT `tenant` claim,
  // looks up the Tenant row, and binds a per-tenant Prisma client.
  // Registered after fastifyPrisma since the multi-tenant plugin
  // depends on app.prisma being available for the Tenant catalog
  // lookup.
  await app.register(fastifyTenantPrisma, {
    multiTenant: config.multiTenant,
    defaultSlug: config.defaultTenantSlug,
    databaseUrl: config.databaseUrl,
    perTenantConnectionLimit: config.perTenantConnectionLimit,
  });
  // Inject the permission resolver — bridges @loan/auth (no prisma dep)
  // to @loan/db (where the schema + RBAC tables live). The resolver also
  // includes active delegations so the delegate's effective permission set
  // is the union of (their own roles ∪ delegated permissions).
  await app.register(fastifyAuth, {
    secret: config.jwtSecret,
    resolvePermissions: async (userId: string) => {
      const { permissions } = await resolveEffectivePermissions(
        app.prisma,
        userId,
      );
      return permissions;
    },
  });

  // Static uploads: KYC documents, customer ID scans, etc.
  const uploadsDir = config.uploadsDir || join(process.cwd(), "uploads");
  await mkdir(uploadsDir, { recursive: true });
  await app.register(staticPlugin, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "Smart Loan API", version: "0.1.0" },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(registerRoutes, { prefix: "/api/v1" });

  // Out-of-band surfaces — NOT under /api/v1 because they aren't part
  // of the tenant API contract.
  //
  //   /platform/* — vendor control plane (apps/platform console).
  //                 Requires a platform: true JWT claim. Tenant tokens
  //                 are rejected.
  //   /public/*   — anonymous endpoints used by apps/marketing
  //                 (lead capture, eventually self-service signup).
  //                 No auth, tight per-route rate limits.
  //
  // Keeping these separate means dev proxies (apps/platform/vite.config,
  // apps/marketing/vite.config) can forward /platform and /public
  // directly without path rewriting, and the OpenAPI spec for the
  // tenant API stays uncluttered.
  await app.register(platformRoutes, { prefix: "/platform" });
  await app.register(publicRoutes, { prefix: "/public" });

  return app;
}
