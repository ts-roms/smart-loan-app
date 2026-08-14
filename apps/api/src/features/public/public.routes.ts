/**
 * Public routes — /public/*. Anonymous, called by the marketing site
 * (apps/marketing) and eventually by the self-service SaaS signup
 * flow.
 *
 *   POST /public/leads           capture a marketing lead
 *   POST /public/signup          request a tenant — records + emails a
 *                                confirmation link, provisions nothing
 *   POST /public/signup/confirm  redeem that link and provision
 *
 * Signup is two steps on purpose. Provisioning creates a Postgres
 * schema and an admin whose password is shown once, so it waits behind
 * a token that only reaches the address being claimed. A typo now
 * costs an expiring row instead of an unreachable tenant.
 *
 * Mounted at the API root, NOT under /api/v1 — the tenant API
 * versioning umbrella doesn't apply to anonymous endpoints. Same
 * level as /platform/* (vendor console API).
 *
 * Auth: none. Don't add anything that touches user data here.
 *
 * Rate limit: tight (5/minute per IP). Anonymous endpoints are the
 * obvious abuse surface; the global 600/minute limit doesn't help
 * here. Per-route override beats the global one.
 *
 * ## Auth posture, stated because documenting nearly broke it
 *
 * There is NO `app.authenticate` hook in this file and there must not
 * be one. Every other group that gained request schemas had to move its
 * auth hook from `preHandler` to `onRequest`, because Fastify validates
 * between the two and an anonymous caller would otherwise get a 400
 * about their body instead of the 401 they earned. **That fix does not
 * apply here and applying it would be the bug**: these routes are
 * anonymous by design — the marketing site and the self-service signup
 * flow call them with no credentials at all — so there is no 401 to
 * protect. Consequently **401 is not declared on any operation below**.
 * Declaring it would send an integrator hunting for a token that does
 * not exist.
 *
 * `429` IS declared on all three, and is the failure a caller here will
 * actually meet. Note it arrives in two different shapes: the rate
 * limiter's own body, and — on `/leads` only — a `DuplicateRecent`
 * refusal the handler raises for a repeat submission within five
 * minutes. Both are `{ error, message }`, which is what the shared
 * component describes.
 *
 * ## The two statuses that used to be unsayable — one now is
 *
 * This file previously reported that `ERRORS` had no 501 and no 500
 * while both were reachable, and declined to hand-roll either locally.
 * That report has been answered, and the two got different answers.
 *
 * **501 is now in `ERRORS` and declared on both signup operations.** It
 * is not an edge case: single-tenant is the DEFAULT mode, so on most
 * deployments 501 is the only answer `/signup` and `/signup/confirm`
 * ever give. A spec that documented a 202 and a 201 those routes will
 * never send, and stayed silent about the status they always do, was
 * describing a different server.
 *
 * **500 `ProvisioningFailed` is deliberately still not in `ERRORS`**,
 * and is named in `/signup/confirm`'s own summary instead. The
 * reasoning is beside the `ERRORS` table, where the next person to
 * consider adding it will look: a shared 500 is the one entry that
 * would end up on every route and mean nothing, and the two surfaces
 * that raise this failure do not even agree on its sibling status.
 */

import type { FastifyInstance } from "fastify";

import { config } from "../../config";
import { routeSchema } from "../../lib/openapi";
import { createNotificationProvider } from "../../providers";
import { PlatformService } from "../platform/platform.service";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";
import {
  captureLeadResponseSchema,
  captureLeadSchema,
  confirmSignupResponseSchema,
  confirmSignupSchema,
  signupResponseSchema,
  signupTenantSchema,
} from "./schemas";

const TAGS = ["public"];

export async function publicRoutes(app: FastifyInstance) {
  // Signup provisions tenants through the same service the vendor
  // console uses, so both paths share one schema-create / migrate /
  // seed implementation and one audit trail.
  const platform = new PlatformService(app.prisma, app, app.log);
  // Platform-level provider, not the tenant-aware wrapper used
  // elsewhere: the confirmation email goes out before the tenant
  // exists, so there's no SystemConfig to consult.
  const notifications = createNotificationProvider(
    config.notificationProvider,
    app.log,
  );
  const service = new PublicService(
    app.prisma,
    app.log,
    platform,
    notifications,
    config.marketingOrigin,
  );
  const ctrl = new PublicController(service);

  app.post(
    "/leads",
    {
      // Per-route limit overrides the global. 5 submissions per minute
      // per IP is more than any genuine human needs; spammers get a
      // 429 quickly without us having to hand-write retry logic.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: routeSchema({
        summary:
          "Capture a marketing lead. Anonymous. Answers `{ ok: true }` " +
          "and no id on purpose — an unauthenticated caller should not " +
          "leave with a handle on the row. 429 covers both the rate " +
          "limit and a repeat submission within five minutes.",
        tags: TAGS,
        public:
          "the marketing site calls it from a browser with no account " +
          "behind it. There is no token that would make this work better.",
        body: captureLeadSchema,
        response: captureLeadResponseSchema,
        status: 201,
        errors: [400, 429],
      }),
    },
    ctrl.captureLead,
  );

  app.post(
    "/signup",
    {
      /**
       * Cheap now — a row and an email — but still capped, because
       * each call sends mail to an address the caller chose. Five an
       * hour is plenty for someone correcting a typo and useless for
       * using us as a mailer.
       */
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: routeSchema({
        summary:
          "Request a tenant. Answers 202, not 201 — nothing is " +
          "provisioned yet. A confirmation link goes to `adminEmail` " +
          "and lapses at `expiresAt`; the token is never in this body. " +
          "409 if the slug is taken.",
        tags: TAGS,
        public:
          "self-service signup, by definition: the caller has no tenant " +
          "yet and so cannot have a token for one.",
        body: signupTenantSchema,
        response: signupResponseSchema,
        status: 202,
        errors: [400, 409, 429, 501],
      }),
    },
    ctrl.requestSignup,
  );

  app.post(
    "/signup/confirm",
    {
      /**
       * The expensive one: a Postgres schema, every migration, seed
       * data — call it 10-15s of server work and permanent disk.
       *
       * Possession of the token is the real control now; this limit
       * exists so someone who can't guess one can't burn server time
       * trying. Three an hour per IP is generous for a human with a
       * link in their inbox.
       */
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
      schema: routeSchema({
        summary:
          "Redeem the confirmation link and provision the tenant. " +
          "`bootstrapPassword` is shown once and never again. A " +
          "malformed token and an unknown one both answer 400 " +
          "`InvalidToken`, deliberately indistinguishable; 409 means " +
          "the link was already used. A **500 `ProvisioningFailed`** is " +
          "also reachable and is the one failure here worth planning " +
          "for: the tenant row exists but its schema is half-built, so " +
          "the answer is neither a retry of this call nor a fresh " +
          "signup — the vendor console's retry-provisioning is. It is " +
          "named here rather than in the shared error table because it " +
          "generalises to nothing else; see the note beside `ERRORS`.",
        tags: TAGS,
        public:
          "the confirmation link is redeemed straight from an email " +
          "client. Possession of the token IS the credential.",
        body: confirmSignupSchema,
        response: confirmSignupResponseSchema,
        status: 201,
        errors: [400, 409, 429, 501],
      }),
    },
    ctrl.confirmSignup,
  );
}
