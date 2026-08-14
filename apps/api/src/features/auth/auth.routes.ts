import {
  type AuditLogRepository,
  type LoginAttemptRepository,
  type PrismaClient,
} from "@loan/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config } from "../../config";
import {
  completeProfileResponseSchema,
  completeProfileSchema,
  forgotPasswordSchema,
  meResponseSchema,
  notificationsStateResponseSchema,
  okResponseSchema,
  permissionsResponseSchema,
  resetPasswordSchema,
  resetTokenParamSchema,
  saveSignatureSchema,
  signatureResponseSchema,
  tokenResponseSchema,
  totpCodeSchema,
  totpDisableResponseSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
  totpStatusResponseSchema,
} from "./schemas";
import { AuthController } from "./auth.controller";
import { PasswordResetService } from "./password-reset.service";
import { AuthService } from "./auth.service";

import { auditFor, loginAttemptsFor } from "../../lib/audit-context";
import { routeSchema } from "../../lib/openapi";

/**
 * Auth feature plugin. Owns every write path on /auth and every /me
 * read. Heavy layered split because every endpoint here is
 * security-critical and audit-coupled — see auth.service.ts for the
 * orchestration contracts.
 *
 * ## Phase 2 tenant resolution
 *
 * Auth is the one feature where tenant resolution is NOT a uniform
 * preHandler:
 *
 *   - **Authenticated routes** (`/me`, `/me/signature`, `/me/2fa/*`,
 *     `/me/permissions`, `/me/notifications/*`) — the JWT is verified
 *     by `app.authenticate` first, then `app.resolveTenant` reads the
 *     `tenant` claim and binds the per-request Prisma client.
 *
 *   - **Unauthenticated credential routes** (`/login`, `/register`,
 *     `/refresh`, `/logout`) — there's no JWT to read from, so the
 *     tenant slug comes from the request body. A dedicated
 *     `resolveTenantFromBody` preHandler handles that path, validating
 *     against the platform-side `Tenant` catalog before issuing the
 *     scoped client.
 *
 * In single-tenant mode (`config.multiTenant === false`) both paths
 * collapse to `app.prisma` + the default slug.
 */

declare module "fastify" {
  interface FastifyRequest {
    authServices?: {
      auth: AuthService;
      /** §56 security log — see AuthController.login. */
      loginAttempts: LoginAttemptRepository;
      /** Request-scoped audit repo, for AUTH_LOGIN / AUTH_LOGOUT. */
      audit: AuditLogRepository;
    };
  }
}

export async function authRoutes(app: FastifyInstance) {
  const auth = new AuthController();

  const TAGS = ["auth"];

  // Tight rate limit on credential endpoints — defends against
  // credential stuffing and account-enumeration probes. Keyed on IP
  // via the global rate-limit plugin's default keyGenerator.
  const authThrottle = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };

  // ── Public credential endpoints ────────────────────────────────────
  // These resolve the tenant from `req.body.tenantSlug`, NOT from a
  // JWT (which doesn't exist yet at login time). The
  // resolveTenantFromBody preHandler does that work and also builds
  // the per-request AuthService against the resolved client.
  const publicPre = [resolveTenantFromBody(app), buildAuthService(app)];

  /*
   * RESPONSES ONLY on this group, and that is deliberate.
   *
   * Attaching a `body` schema makes Fastify validate at preValidation —
   * BEFORE `resolveTenantFromBody` runs. That preHandler answers a
   * missing or unknown tenant with a 401 worded byte-identically to a
   * wrong password, precisely so a prober cannot tell the two apart. A
   * schema in front of it would answer the same request with a 400
   * naming the field at fault, moving the line between "malformed" and
   * "refused" on the most-integrated-against routes in the API and
   * handing back a description of the credential shape to callers who
   * have not authenticated.
   *
   * The request shapes are `loginSchema` / `registerSchema` /
   * `refreshSchema` in ./schemas.ts and the controller still parses
   * against them; what is published here is what comes BACK, which is
   * the part an integrator cannot discover by reading the client.
   */
  app.post(
    "/login",
    {
      ...authThrottle,
      preHandler: publicPre,
      schema: routeSchema({
        summary:
          "Exchange email + password (+ 2FA code) for an access and " +
          "refresh token pair.",
        tags: TAGS,
        public: "this is where a token comes FROM.",
        response: tokenResponseSchema,
        // 401 covers all four refusals — bad credentials, bad TOTP, bad
        // recovery code, and "second factor required". The last carries
        // `requires2fa: true` and means the password WAS right.
        errors: [400, 401, 429],
      }),
    },
    auth.login,
  );
  app.post(
    "/register",
    {
      ...authThrottle,
      preHandler: publicPre,
      schema: routeSchema({
        summary:
          "Self-register a borrower account. Creates a CUSTOMER with no " +
          "Customer record yet — /auth/me/profile completes it.",
        tags: TAGS,
        public: "self-registration: there is no account to hold a token yet.",
        response: tokenResponseSchema,
        status: 201,
        // 409 is the address already being registered.
        errors: [400, 401, 409, 429],
      }),
    },
    auth.register,
  );
  app.post(
    "/refresh",
    {
      ...authThrottle,
      preHandler: publicPre,
      schema: routeSchema({
        summary:
          "Rotate a refresh token for a new pair. Re-using a spent token " +
          "revokes every session for that user.",
        tags: TAGS,
        public:
          "an EXPIRED access token is the normal reason to call this, so " +
          "requiring a valid one would defeat the endpoint. The refresh " +
          "token in the body is the credential.",
        response: tokenResponseSchema,
        errors: [400, 401, 429],
      }),
    },
    auth.refresh,
  );
  app.post(
    "/logout",
    {
      preHandler: publicPre,
      schema: routeSchema({
        summary:
          "Revoke the presented refresh token. Succeeds even for a token " +
          "that was never valid, so it cannot be used as an oracle.",
        tags: TAGS,
        public:
          "signing out has to work for someone whose access token has " +
          "already expired, which is the common case. The refresh token " +
          "being revoked travels in the body.",
        /*
         * The 401 is real, and it does NOT come from the handler —
         * `AuthController.logout` answers 204 unconditionally, on
         * purpose, so the route cannot be used as an oracle.
         *
         * It comes from `resolveTenantFromBody` in `publicPre`, which
         * refuses a missing or unknown `tenantSlug` with 401 before the
         * handler runs. That resolver short-circuits when
         * `config.multiTenant` is false, so on a single-tenant
         * deployment — the default — this route really does only ever
         * answer 204, and probing one is what makes the declaration
         * look false. It was reported as exactly that. Verified on
         * MULTI_TENANT=true:
         *
         *   POST /auth/logout  {"refreshToken":"whatever"}
         *   -> 401 {"error":"Unauthorized",
         *           "message":"Invalid email or password"}
         *
         * Every route in this group declares 401 for this reason, and
         * two of them — `/forgot-password` (always 202) and this one —
         * have no other source for it. Dropping it here would make the
         * spec wrong for every multi-tenant deployment.
         */
        errors: [401],
      }),
    },
    auth.logout,
  );

  // ── Password reset ─────────────────────────────────────────────────
  //
  // Harder-limited than login: a reset request sends mail, so an
  // unthrottled endpoint is both an enumeration probe and a way to
  // use someone's inbox as a target. 5/minute per IP.
  const resetThrottle = {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  };

  /*
   * NO `body` schema here, and this one is not a judgement call.
   *
   * The handler below answers 202 even for a body that is not an email,
   * on purpose: a 400 would separate "not an email" from "no such
   * account", which is the exact distinction the endpoint exists to
   * hide. `forgotPasswordSchema` in front of it would reintroduce that
   * 400 at preValidation, before the handler ever runs.
   */
  app.post<{ Body: unknown }>(
    "/forgot-password",
    {
      ...resetThrottle,
      preHandler: publicPre,
      schema: routeSchema({
        summary:
          "Start a password reset. Always answers 202, whether or not the " +
          "address matches an account.",
        tags: TAGS,
        public: "the only person who calls this is one who cannot sign in.",
        response: okResponseSchema,
        status: 202,
        errors: [401, 429],
      }),
    },
    async (req, reply) => {
      const parsed = forgotPasswordSchema.safeParse(req.body);
      // Even a malformed body gets the standard answer. A 400 here
      // would distinguish "not an email" from "no such account",
      // which is the distinction this endpoint exists to hide.
      if (parsed.success) {
        await buildResetService(app, req).request(parsed.data.email);
      }
      return reply.code(202).send({ ok: true });
    },
  );

  // Lets the reset page say "this link has expired" on arrival rather
  // than after someone has typed a new password twice.
  app.get<{ Params: { token: string } }>(
    "/reset-password/:token",
    {
      ...resetThrottle,
      preHandler: publicPre,
      schema: routeSchema({
        summary:
          "Check a reset link before showing the form. A spent or expired " +
          "link answers 410 Gone with the reason.",
        tags: TAGS,
        public:
          "the emailed token in the path IS the credential; a caller who " +
          "could authenticate would not need a reset link.",
        params: resetTokenParamSchema,
        response: okResponseSchema,
        /*
         * The 410 IS declared now. It was left out when this route was
         * documented because `ERRORS` had no entry and inventing one
         * locally would have been a second definition of the error
         * envelope — that was the right call, and the batch that added
         * 410 centrally for the co-maker consent links answered it. The
         * comment saying it cannot be declared outlived the fact by one
         * batch, which is exactly how a spec starts lying.
         */
        errors: [401, 410, 429],
      }),
    },
    async (req, reply) => {
      const result = await buildResetService(app, req).check(req.params.token);
      if (!result.ok) {
        return reply.code(410).send({ error: result.reason });
      }
      return { ok: true };
    },
  );

  /*
   * Also responses-only. `resetPasswordSchema` rejects a token shorter
   * than 20 characters, and a schema in front of the handler would turn
   * a truncated link — the commonest way a reset URL arrives broken,
   * via a mail client wrapping it — into a 400 about `minLength`
   * instead of the 410 "this link has expired" the reset page renders.
   */
  app.post<{ Body: unknown }>(
    "/reset-password",
    {
      ...resetThrottle,
      preHandler: publicPre,
      schema: routeSchema({
        summary:
          "Redeem a reset link and set a new password. A spent or expired " +
          "link answers 410 Gone.",
        tags: TAGS,
        public:
          "the emailed token in the body IS the credential. Requiring a " +
          "bearer token would make the reset flow impossible to complete.",
        response: okResponseSchema,
        // 410 for the same reason as the GET above: the link is gone,
        // not the credentials wrong, and the shared table can now say so.
        errors: [400, 401, 410, 429],
      }),
    },
    async (req, reply) => {
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const result = await buildResetService(app, req).reset(
        parsed.data.token,
        parsed.data.password,
      );
      if (!result.ok) {
        // 410, not 401: the link is gone, not the credentials wrong.
        // The reason is safe to name — the caller already holds the
        // token, so it reveals nothing about whose it is.
        return reply.code(410).send({ error: result.reason });
      }
      return { ok: true };
    },
  );

  // ── Authenticated routes ───────────────────────────────────────────
  // app.authenticate verifies the JWT → req.user is set with the
  // tenant claim. app.resolveTenant reads it and binds req.tenantCtx.
  // buildAuthService then instantiates the per-request service.
  //
  // authenticate runs at ONREQUEST, not preHandler, and the two are not
  // interchangeable here. Fastify validates a route's request schema at
  // preValidation, which is BEFORE preHandler: with authenticate one
  // stage later, an unauthenticated caller posting a malformed body to
  // /me/2fa/enable got a 400 describing the schema instead of a 401 —
  // an unauthenticated reader learning the request shape. onRequest is
  // earlier than validation, so the 401 wins again. Same fix, same
  // reason, as loans.routes.ts.
  const authed = {
    onRequest: app.authenticate,
    preHandler: [app.resolveTenant, buildAuthService(app)],
  };

  app.get(
    "/me",
    {
      ...authed,
      schema: routeSchema({
        summary: "The signed-in account: identity, role and customer link.",
        tags: TAGS,
        response: meResponseSchema,
        // 404 is the token verifying against a user row that no longer
        // exists — a deleted account holding a live access token.
        errors: [401, 404],
      }),
    },
    auth.me,
  );

  // Completes a self-registered borrower's profile. Authenticated, but
  // deliberately NOT gated on already having a customer link — this is
  // the endpoint that creates that link, so requiring one would
  // deadlock every account it exists for.
  app.post(
    "/me/profile",
    {
      ...authed,
      schema: routeSchema({
        summary:
          "Complete a self-registered borrower's profile: create the " +
          "Customer record and link it to the login.",
        tags: TAGS,
        body: completeProfileSchema,
        response: completeProfileResponseSchema,
        status: 201,
        // 403 is a staff account asking — they have no borrower record
        // by design. 409 is the profile already existing; edits go
        // through the portal's own profile endpoint.
        errors: [400, 401, 403, 404, 409],
      }),
    },
    auth.completeProfile,
  );

  app.get(
    "/me/signature",
    {
      ...authed,
      schema: routeSchema({
        summary: "The caller's saved signature image, if they have one.",
        tags: TAGS,
        response: signatureResponseSchema,
        errors: [401, 404],
      }),
    },
    auth.getSignature,
  );
  app.put(
    "/me/signature",
    {
      ...authed,
      schema: routeSchema({
        summary: "Save the caller's default signature image. Audited.",
        tags: TAGS,
        body: saveSignatureSchema,
        response: signatureResponseSchema,
        errors: [400, 401],
      }),
    },
    auth.setSignature,
  );
  app.delete(
    "/me/signature",
    {
      ...authed,
      schema: routeSchema({
        summary:
          "Clear the caller's saved signature. Answers the same pair with " +
          "both fields null, not a 204.",
        tags: TAGS,
        response: signatureResponseSchema,
        errors: [401],
      }),
    },
    auth.clearSignature,
  );
  app.get(
    "/me/permissions",
    {
      ...authed,
      schema: routeSchema({
        summary:
          "Permission keys and roles for the caller. Advisory — the " +
          "server-side gate is what actually decides.",
        tags: TAGS,
        response: permissionsResponseSchema,
        errors: [401],
      }),
    },
    auth.permissions,
  );

  // Notification bell state
  app.get(
    "/me/notifications/state",
    {
      ...authed,
      schema: routeSchema({
        summary: "Unseen notification count and the caller's last-seen mark.",
        tags: TAGS,
        response: notificationsStateResponseSchema,
        errors: [401, 404],
      }),
    },
    auth.notificationsState,
  );
  app.post(
    "/me/notifications/seen",
    {
      ...authed,
      schema: routeSchema({
        summary:
          "Move the last-seen mark to now. Answers the fresh bell state, " +
          "so the client repaints from the write.",
        tags: TAGS,
        response: notificationsStateResponseSchema,
        errors: [401],
      }),
    },
    auth.markNotificationsSeen,
  );

  // 2FA (TOTP) — three-step setup flow + disable
  app.get(
    "/me/2fa/status",
    {
      ...authed,
      schema: routeSchema({
        summary: "Whether 2FA is on, and how many recovery codes are left.",
        tags: TAGS,
        response: totpStatusResponseSchema,
        errors: [401, 404],
      }),
    },
    auth.totpStatus,
  );
  app.post(
    "/me/2fa/setup",
    {
      ...authed,
      schema: routeSchema({
        summary:
          "Generate a TOTP secret and otpauth URI. Does not turn 2FA on — " +
          "/enable confirms a code first.",
        tags: TAGS,
        response: totpSetupResponseSchema,
        // 409 is 2FA already being enabled: disable it before re-setting up.
        errors: [401, 404, 409],
      }),
    },
    auth.totpSetup,
  );
  app.post(
    "/me/2fa/enable",
    {
      ...authed,
      schema: routeSchema({
        summary:
          "Confirm a code against the stashed secret and turn 2FA on. " +
          "Returns the recovery codes in clear, once.",
        tags: TAGS,
        body: totpCodeSchema,
        response: totpEnableResponseSchema,
        // A wrong code and a missing /setup are both 400, not 401: the
        // caller is authenticated, the code just did not verify.
        errors: [400, 401],
      }),
    },
    auth.totpEnable,
  );
  app.post(
    "/me/2fa/disable",
    {
      ...authed,
      schema: routeSchema({
        summary:
          "Turn 2FA off. Requires a fresh code, so a hijacked session " +
          "alone cannot do it.",
        tags: TAGS,
        body: totpCodeSchema,
        response: totpDisableResponseSchema,
        // 409 is 2FA not being on in the first place.
        errors: [400, 401, 409],
      }),
    },
    auth.totpDisable,
  );
}

// ─── preHandlers ──────────────────────────────────────────────────────

/**
 * Read `tenantSlug` from the request body, validate against the
 * platform-side Tenant catalog, and populate `req.tenantCtx`. Used by
 * /login, /register, /refresh, /logout — the routes that don't have
 * a verified JWT yet.
 *
 * In single-tenant mode this short-circuits to the default slug and
 * `app.prisma`; no Tenant lookup runs, so single-tenant deployments
 * don't need a Tenant row to exist at all.
 *
 * Validation strategy: on a missing-or-bad tenant we 401 with a
 * generic message (same shape login uses for bad creds). We don't
 * leak which slugs exist; an attacker probing `tenantSlug=acme` vs
 * `tenantSlug=ghost-corp` sees the same response.
 */
function resolveTenantFromBody(app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!config.multiTenant) {
      req.tenantCtx = {
        slug: config.defaultTenantSlug,
        prisma: app.prisma,
      };
      return;
    }

    const body = (req.body ?? {}) as { tenantSlug?: unknown };
    const claim = body.tenantSlug;
    if (typeof claim !== "string" || !/^[a-z][a-z0-9-]+$/.test(claim)) {
      await reply.code(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
      return;
    }

    const tenant = await app.prisma.tenant.findUnique({
      where: { slug: claim },
      select: { status: true },
    });
    if (!tenant || tenant.status !== "ACTIVE") {
      // Byte-identical to the wrong-password reply — a different
      // wording here would tell a prober the tenant exists.
      await reply.code(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
      return;
    }

    req.tenantCtx = {
      slug: claim,
      prisma: app.tenantPrisma.get(claim),
    };
  };
}

/**
 * Instantiate the per-request AuthService bound to the resolved
 * tenant Prisma client. Reads `req.tenantCtx` (set by one of the two
 * tenant resolvers above) and writes `req.authServices`.
 *
 * The service depends on prisma + an audit log repo + two Fastify-
 * decorated capabilities (jwt.sign + resolvePermissions). The
 * AuditLogRepository is constructed per-request because it captures
 * the prisma client — cheap (just a class instance) and keeps the
 * audit trail aligned with the tenant scope.
 */
/**
 * Per-request, like buildAuthService — it captures the tenant client
 * and the tenant's notification provider, so a reset mail goes out
 * under the right cooperative's branding.
 */
function buildResetService(app: FastifyInstance, req: FastifyRequest) {
  const prisma: PrismaClient = req.tenantCtx.prisma;
  return new PasswordResetService(
    prisma,
    app.notifications(prisma),
    config.webOrigin,
    config.companyName,
    app.log,
  );
}

function buildAuthService(app: FastifyInstance) {
  return async (req: FastifyRequest): Promise<void> => {
    const prisma: PrismaClient = req.tenantCtx.prisma;
    // `auditFor` also carries the §56 request context (tenant, IP, user
    // agent, request id) and the pino logger.
    const audit = auditFor(req, prisma);
    const service = new AuthService(
      prisma,
      audit,
      (payload, opts) => app.jwt.sign(payload, opts),
      // Resolve against the tenant's schema — the RBAC tables live
      // there, not in the public schema.
      (userId) => app.resolvePermissions(userId, prisma),
    );
    req.authServices = {
      auth: service,
      loginAttempts: loginAttemptsFor(req, prisma),
      audit,
    };
  };
}
