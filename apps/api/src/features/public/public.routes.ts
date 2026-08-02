/**
 * Public routes — /public/*. Anonymous, called by the marketing site
 * (apps/marketing) and eventually by the self-service SaaS signup
 * flow.
 *
 *   POST /public/leads    capture a marketing lead (rate-limited)
 *   POST /public/signup   self-serve tenant provisioning (rate-limited
 *                         hard — see the note on the route)
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

import { PlatformService } from "../platform/platform.service";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

export async function publicRoutes(app: FastifyInstance) {
  // Signup provisions tenants through the same service the vendor
  // console uses, so both paths share one schema-create / migrate /
  // seed implementation and one audit trail.
  const platform = new PlatformService(app.prisma, app, app.log);
  const service = new PublicService(app.prisma, app.log, platform);
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
       * Far tighter than /leads, and for a different reason. A lead is
       * a row; a signup creates a Postgres schema, runs every
       * migration against it, and seeds it — call it ~10-15s of server
       * work and permanent disk. Three per hour per IP is generous for
       * a human registering one cooperative and useless to anyone
       * trying to exhaust the database with schemas.
       *
       * Worth knowing: this is per-IP, so it does not stop a
       * distributed attempt. Email verification before provisioning is
       * the real fix, and is the natural next step here.
       */
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
    },
    ctrl.signupTenant,
  );
}
