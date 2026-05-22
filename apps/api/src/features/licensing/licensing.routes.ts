/**
 * Licensing routes — status + activate + deactivate.
 *
 * `admin.roles` gates the mutating routes since license state
 * affects which features the org has access to. The read route is
 * open to any authenticated user so the dashboard banner /
 * status pill on every page can show "X days until expiry".
 *
 * This plugin also decorates `app.requireFeature(flag)` — a Fastify
 * middleware factory that blocks routes when the active license
 * doesn't include the given feature flag. Used as the preHandler on
 * premium routes throughout the API.
 *
 * Layered: routes → controller → service → repo + audit.
 */

import { AuditLogRepository } from "@loan/db";
import { type FeatureFlag, loadPublicKeyPem } from "@loan/licensing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { LicensingController } from "./licensing.controller";
import { LicensingService } from "./licensing.service";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Feature-gate factory. Pass one or more feature flags; the
     * preHandler resolves the current license on first call per
     * request, caches it, and 402s if NONE of the flags are present
     * in the license's feature set.
     *
     * Why 402 (Payment Required): it's the historically-vacant HTTP
     * status reserved for "this feature exists but isn't available
     * on your plan". 403 would suggest a permissions problem the
     * admin could fix from /roles; 402 tells the api-client to route
     * the user to the upgrade flow.
     */
    requireFeature: (
      ...flags: FeatureFlag[]
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function licensingRoutes(app: FastifyInstance) {
  // Public-key resolution happens once at plugin registration time.
  // Mutating the env after boot won't re-load it; that's intentional
  // — rotating the key requires a restart for safety.
  const publicKey = loadPublicKeyPem();
  if (!publicKey) {
    app.log.warn(
      "License public key not configured (LICENSE_PUBLIC_KEY_PEM / LICENSE_PUBLIC_KEY_PATH). Running in grace mode — every license check will return NO_KEY.",
    );
  }

  const service = new LicensingService(
    app.prisma,
    new AuditLogRepository(app.prisma),
    app.log,
    publicKey,
  );
  const ctrl = new LicensingController(service);

  // Decorate the app with the current license loader so other features
  // can consult it. The requireFeature decorator (below) wraps a
  // per-request cache around the same loadCurrent() so we verify the
  // license signature exactly once per request that needs it.
  app.decorate("license", service);

  // requireFeature(flag) — feature-gate preHandler factory.
  app.decorate("requireFeature", (...flags: FeatureFlag[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      // Cache on the request so the same call in a multi-preHandler
      // chain doesn't re-verify the Ed25519 signature N times. Cheap
      // either way (microseconds), but keeping things tidy.
      const cached = (
        req as {
          licenseCheck?: Awaited<ReturnType<typeof service.loadCurrent>>;
        }
      ).licenseCheck;
      const current = cached ?? (await service.loadCurrent());
      (req as { licenseCheck?: typeof current }).licenseCheck = current;

      if (!current.ok) {
        // Map the failure kind to a 402 body the client can act on.
        // The api-client surfaces the `kind` so the UI can show
        // "License expired" vs "Feature locked" appropriately.
        return reply.code(402).send({
          error: "FeatureLocked",
          kind: current.kind, // NoneActive | Expired | Tampered | NoKeyConfigured
          message: current.message,
          requiredFeatures: flags,
        });
      }
      // Active license — does it include any of the requested flags?
      const granted = new Set(current.payload.features);
      const ok = flags.some((f) => granted.has(f));
      if (!ok) {
        return reply.code(402).send({
          error: "FeatureLocked",
          kind: "FeatureMissing",
          message: `This feature requires one of: ${flags.join(", ")}. Your ${current.payload.tier} license doesn't include it.`,
          requiredFeatures: flags,
          tier: current.payload.tier,
        });
      }
    };
  });

  app.addHook("preHandler", app.authenticate);

  // Read endpoint — every authenticated user. The dashboard renders
  // a status banner on every page so this needs to be reachable
  // without admin.roles.
  app.get("/status", ctrl.status);

  app.post(
    "/activate",
    { preHandler: app.requirePermission("admin.roles") },
    ctrl.activate,
  );

  app.post(
    "/deactivate",
    { preHandler: app.requirePermission("admin.roles") },
    ctrl.deactivate,
  );
}
