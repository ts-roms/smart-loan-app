/**
 * Public routes — /public/*. Anonymous, called by the marketing site
 * (apps/marketing) and eventually by the self-service SaaS signup
 * flow.
 *
 *   POST /public/leads    capture a marketing lead (rate-limited)
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

import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

export async function publicRoutes(app: FastifyInstance) {
  const service = new PublicService(app.prisma, app.log);
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
}
