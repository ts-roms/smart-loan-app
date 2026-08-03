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
 */

import type { FastifyInstance } from "fastify";

import { config } from "../../config";
import { createNotificationProvider } from "../../providers";
import { PlatformService } from "../platform/platform.service";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

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
    },
    ctrl.confirmSignup,
  );
}
