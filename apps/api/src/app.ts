import { fastifyAuth } from "@loan/auth";
import {
  fastifyPrisma,
  fastifyTenantPrisma,
  type PrismaClient,
  resolveEffectivePermissions,
} from "@loan/db";
import { shouldStampHeartbeat } from "@loan/shared-utils";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { config } from "./config";
import { decorateFeatureGate } from "./features/licensing/feature-gate.plugin";
import { platformRoutes } from "./features/platform/index";
import { coMakerConsentRoutes } from "./features/co-maker/consent.routes";
import { publicRoutes } from "./features/public/index";
import { registerRoutes } from "./routes/index";
import { describeStorage, uploadStorage } from "./features/uploads/backend";
import { uploadStaticPlugin } from "./features/uploads/static.plugin";
import { validationBodyOf, validationError } from "./lib/validation-error";

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
    /*
     * Request id: inbound `X-Request-Id` if the caller supplied a usable
     * one, otherwise a fresh UUID.
     *
     * Fastify's default is an in-process counter — `req-1`, `req-2`,
     * restarting from 1 on every boot and running independently in every
     * replica. As a correlation id that is actively misleading: two
     * different requests on two instances share an id, and an audit row
     * stamped `req-7` cannot be tied to anything. §56 asks for a request
     * id on every audit record, and the id has to be globally
     * distinguishable for that to mean anything.
     *
     * Seeding from the header lets a correlation id set at the edge (load
     * balancer, gateway, or the web app) span the whole call chain, so a
     * support ticket quoting one id finds the API log lines, the audit
     * rows, and the upstream trace together.
     *
     * The inbound value is validated before it is trusted: it is
     * attacker-controlled, it ends up in log lines and in a response
     * header, and it is written to an audit column. Anything with
     * whitespace, control characters or CR/LF (header injection) or over
     * 128 chars is discarded in favour of a generated UUID. Discarding is
     * the right response rather than sanitising — a caller sending a
     * malformed id gets a valid one back and nothing is silently
     * rewritten under them.
     */
    genReqId(req) {
      const header = req.headers["x-request-id"];
      const candidate = Array.isArray(header) ? header[0] : header;
      if (
        typeof candidate === "string" &&
        candidate.length > 0 &&
        candidate.length <= 128 &&
        // Printable ASCII minus space — covers UUIDs, ULIDs, W3C
        // traceparent values and the hex ids most gateways emit, while
        // excluding CR/LF and other control characters outright.
        /^[\x21-\x7e]+$/.test(candidate)
      ) {
        return candidate;
      }
      return randomUUID();
    },
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

  /*
   * Keep the 400 body the controllers already produce.
   *
   * Attaching a request schema to a route for the OpenAPI spec has a
   * side effect that is easy to miss and was missed here first: Fastify
   * VALIDATES against it, and its default rejection is a bare
   * `{ "error": "Bad Request" }`. Every controller in this codebase
   * instead returns `{ error: "ValidationError", issues: [...] }` from
   * its own zod parse, which tells the caller WHICH field was wrong.
   *
   * Documenting a request must not make the API less useful to the
   * people reading the documentation. So the formatter below re-shapes
   * Fastify's rejection into the body callers already get, mapping
   * AJV's `instancePath` onto zod's `path`. The controller's parse still
   * runs for everything Fastify lets through, and remains the real gate
   * — this only covers the requests it now rejects earlier.
   *
   * The body itself lives in lib/validation-error.ts, because a handler
   * can raise the same failure for something JSON Schema cannot express
   * (see `parseAsOf` in accounting.routes.ts) and the two must not
   * diverge.
   */
  app.setSchemaErrorFormatter((errors, dataVar) =>
    validationError(
      errors.map((e) => ({
        path: (e.instancePath || "")
          .split("/")
          .filter(Boolean)
          .map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
        message: e.message ?? "Invalid value",
        // Which part of the request failed: body, querystring, params.
        in: dataVar,
      })),
    ),
  );

  /*
   * One handler, not two. `setErrorHandler` REPLACES rather than chains,
   * so a second registration for the validation body would silently
   * disable Sentry reporting on any deployment that has it configured.
   * The validation branch lives inside the one handler instead, and the
   * no-Sentry path gets its own minimal registration below.
   */
  if (sentry) {
    app.setErrorHandler((err: FastifyError, req, reply) => {
      const body = validationBodyOf(err);
      if (body) return reply.code(400).send(body);
      // Don't ship validation/expected 4xx noise to Sentry — only the
      // genuine 5xx-class problems are useful signal.
      if (!err.statusCode || err.statusCode >= 500) {
        sentry.captureException(err, (scope) => {
          // Fastify 5 dropped req.routerPath in favour of routeOptions.url;
          // we fall through to the raw request URL when the route hasn't
          // been resolved (e.g. 404s before routing).
          scope.setTag("route", req.routeOptions?.url ?? req.url);
          scope.setTag("method", req.method);
          // Tenant context. When `resolveTenant` has run, the request
          // already knows which schema it was about to query. Tagging
          // every Sentry event with the tenant slug lets the vendor
          // filter the error stream per customer — critical for SaaS
          // support ("we're seeing 500s; which tenant?"). In single-
          // tenant mode the value is "default", which is also useful
          // — distinguishes errors during the cutover window.
          const tenantSlug = (req as { tenantCtx?: { slug?: string } })
            .tenantCtx?.slug;
          if (tenantSlug) scope.setTag("tenant", tenantSlug);
          // Surface impersonation explicitly. If a vendor support
          // session caused the error, the alert email shouldn't read
          // "ADMIN_USER triggered a 500" — it should read "VENDOR_OPS
          // (impersonating ADMIN_USER) triggered a 500".
          const impersonator = (
            req.user as
              { impersonatedBy?: { platformUserEmail?: string } } | undefined
          )?.impersonatedBy;
          if (impersonator) {
            scope.setTag("impersonated", "true");
            scope.setTag(
              "impersonator",
              impersonator.platformUserEmail ?? "unknown",
            );
          }
          const sub = (req.user as { sub?: string } | undefined)?.sub;
          if (sub) scope.setUser({ id: sub });
          return scope;
        });
      }
      reply.send(err);
    });
  } else {
    // Same validation branch, without the Sentry reporting. Everything
    // else falls through to Fastify's default serialisation.
    app.setErrorHandler((err: FastifyError, _req, reply) => {
      const body = validationBodyOf(err);
      if (body) return reply.code(400).send(body);
      return reply.send(err);
    });
  }

  /*
   * CSP off in helmet, set by the hook below instead.
   *
   * helmet applies one policy to every route, and this API has three
   * kinds of response that need three different answers: JSON (which
   * needs nothing at all), Swagger UI at /docs (which is a real HTML app
   * and needs scripts), and /uploads/ (which must never execute —
   * handled in its own plugin, next to the signature check it belongs
   * with). A single global policy would have to be loose enough for
   * /docs, which is the same as having none where it matters.
   */
  await app.register(helmet, { contentSecurityPolicy: false });

  /*
   * Everything this API returns is JSON, so it needs no sources at all.
   *
   * `default-src 'none'` costs nothing on a JSON response and closes the
   * case where one is rendered as a document — an error page, a
   * content-type slip, a browser sniffing an unexpected body.
   * `frame-ancestors 'none'` is the modern X-Frame-Options and stops
   * this API being framed.
   *
   * /docs is exempt because Swagger UI is a genuine HTML application;
   * /uploads/ is exempt here because it sets its own, stricter policy.
   * Both exemptions are by prefix rather than by route so a new path
   * under either inherits the right answer.
   */
  /*
   * Echo the request id back to the caller.
   *
   * Without this the id is only ever visible server-side, which makes it
   * useless for the thing it is for: a user reporting "my disbursement
   * failed" can quote the header, and support can go straight to the log
   * lines and the audit rows for that exact request. Set in `onRequest`
   * so it is present even on responses that never reach a route handler
   * — 404s, rate-limit 429s and error-handler 500s are the ones people
   * actually open tickets about.
   */
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
  });

  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/docs") || req.url.startsWith("/uploads/")) return;
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    // Without this the browser hides X-Request-Id from the web app, and
    // the id can only be recovered from server logs — which defeats the
    // point of echoing it. Exposing it lets the SPA show the id on an
    // error screen so the user can quote it in a ticket.
    exposedHeaders: ["X-Request-Id"],
  });
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
  //
  // `tenantPrisma` is the caller's `req.tenantCtx.prisma`, threaded in by
  // `requirePermission` (and by the handful of feature routes that call
  // `app.resolvePermissions` directly). It MUST be used when present:
  // User / Role / UserRoleAssignment / Delegation all live in the
  // tenant's own schema, so resolving against `app.prisma` in
  // MULTI_TENANT=true mode reads the public schema, finds no roles, and
  // denies every gated route. The `app.prisma` fallback is only correct
  // in single-tenant mode, where the two are the same client anyway.
  await app.register(fastifyAuth, {
    secret: config.jwtSecret,
    resolvePermissions: async (userId: string, tenantPrisma?: unknown) => {
      const { permissions } = await resolveEffectivePermissions(
        (tenantPrisma as PrismaClient | undefined) ?? app.prisma,
        userId,
      );
      return permissions;
    },
    /*
     * Turns `authenticate` from a signature check into a check that the
     * account is still allowed to be here — see the comment at the use
     * site in @loan/auth. Same tenant-client threading as the
     * permission resolver above and for the same reason: User lives in
     * the tenant's schema, so resolving against `app.prisma` under
     * MULTI_TENANT=true reads the public schema and finds nobody.
     *
     * Reading through `tenantPrisma` also means a token minted for
     * tenant A cannot satisfy this check against tenant B — the user id
     * simply isn't there, the resolver returns null, and the request is
     * rejected.
     */
    resolveSessionStatus: async (userId: string, tenantPrisma?: unknown) => {
      const db = (tenantPrisma as PrismaClient | undefined) ?? app.prisma;
      const row = await db.user.findUnique({
        where: { id: userId },
        select: { active: true, sessionsRevokedAt: true, lastSeenAt: true },
      });
      if (!row) return null;

      /*
       * Presence heartbeat, riding along on a read this request was
       * already making.
       *
       * This is the only place in the app that touches the User row on
       * every authenticated request, which makes it the one spot where
       * "when did we last hear from them" costs nothing extra to
       * decide. Throttled to at most one UPDATE per user per
       * HEARTBEAT_MS — without that, a busy officer would generate a
       * write per request to record a fact that changes once every
       * thirty seconds.
       *
       * Deliberately not awaited. The answer to "is this session
       * valid" does not depend on it, and making every request in the
       * system wait on a bookkeeping write to power a status dot would
       * be the wrong trade. `.catch` is not optional here: an
       * unawaited rejection would take the process down under Node's
       * default unhandled-rejection behaviour, and a failed heartbeat
       * must never cost anyone their request.
       */
      if (shouldStampHeartbeat(row.lastSeenAt, Date.now())) {
        void db.user
          .update({ where: { id: userId }, data: { lastSeenAt: new Date() } })
          .catch((err: unknown) => {
            app.log.debug({ err, userId }, "heartbeat write failed");
          });
      }

      return {
        active: row.active,
        sessionsRevokedAtMs: row.sessionsRevokedAt?.getTime() ?? null,
      };
    },
  });
  // Feature-gate decorator (`app.requireFeature`). Decorated on the root
  // instance — after auth + tenant resolution (the gate reads the
  // caller's tenant license via req.tenantCtx.prisma at request time)
  // and before the feature routes that consume it in registerRoutes
  // below. Direct decoration (not app.register) keeps it on the root so
  // every child route plugin inherits it.
  decorateFeatureGate(app);

  // Static uploads: KYC documents, customer ID scans, etc.
  //
  // Registered as its own plugin so the signature check is scoped to
  // these routes and testable on its own — see static.plugin.ts.
  //
  // The backend is local disk unless STORAGE_DRIVER says otherwise; the
  // boot-time mkdir is therefore conditional on actually having a local
  // root, since there is no directory to create for a bucket.
  const storage = uploadStorage(app.log);
  if (storage.localRoot !== undefined) {
    await mkdir(storage.localRoot, { recursive: true });
  }
  app.log.info(`[storage] uploads backed by ${describeStorage()}`);
  await app.register(uploadStaticPlugin, { storage });

  /*
   * The spec described 336 operations and said nothing about how to
   * authenticate for any of them. Every route but /health and the
   * public consent links needs a bearer token, and a reader had no way
   * to learn that from the document — /docs rendered a "Try it out"
   * button that could only ever return 401.
   *
   * Declared once and applied globally rather than per route, because
   * bearer auth IS the default here: `app.authenticate` is a preHandler
   * on essentially every route group. The handful of genuinely public
   * ones are the exception and should say so on themselves; a spec that
   * required each of 336 routes to repeat the rule would be wrong on the
   * first one somebody forgot.
   *
   * THE EXCEPTIONS NOW DO SAY SO. `routeSchema` emits `security` on
   * every operation, so the twenty-four anonymous ones carry
   * `security: []` and stop inheriting a token requirement that would
   * send an integrator hunting for credentials a payment gateway cannot
   * have. This global default stays exactly where it is — it is still
   * the right answer for anything added tomorrow, and it is what a
   * route that forgets to declare falls back to.
   *
   * TWO schemes, because there are two credentials. `/platform/*` is
   * the vendor control plane: its token comes from a different login,
   * carries `platform: true`, and each side rejects the other's token
   * (see `platformAuthenticate` in platform.routes and the
   * `payload.platform` check in @loan/auth). Publishing one scheme for
   * both would tell a cooperative's integrator that the token they hold
   * reaches the vendor console.
   */
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Smart Loan API",
        version: "0.1.0",
        description:
          "Lending operations for Philippine cooperatives.\n\n" +
          "**Status codes.** 409 means the request was well-formed and you " +
          "were entitled to make it — the target's STATE refused. Retrying " +
          "it unchanged will fail the same way; something else has to move " +
          "first. 402 means the tenant's licence does not include the " +
          "feature, which is not an authorisation problem and is not fixed " +
          "by a different token.\n\n" +
          "**Money** is returned as a decimal string, not a float, so it " +
          "survives the round trip without a rounding error.",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "Tenant access token from POST /auth/login. Short-lived; " +
              "refresh with POST /auth/refresh. Rejected by /platform/*.",
          },
          platformAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "Vendor control-plane token from POST /platform/auth/login, " +
              "carrying a `platform: true` claim. Only /platform/* accepts " +
              "it, and every /api/v1 route rejects it — the two tokens are " +
              "not interchangeable in either direction.",
          },
        },
      },
      security: [{ bearerAuth: [] }],
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
  // Co-maker consent. Anonymous like /public, but kept out of
  // publicRoutes because that file's contract is "nothing here touches
  // user data" and this reads a loan. The invite token is the
  // authorization; see consent.routes.
  await app.register(coMakerConsentRoutes, { prefix: "/public/co-maker" });

  return app;
}
