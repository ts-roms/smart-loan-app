/**
 * Feature-gate decorator — registers `app.requireFeature(...)` on the
 * root instance so every feature route plugin can gate itself behind a
 * license flag.
 *
 * Why decorate the ROOT app directly (rather than via app.register):
 * `app.decorate` inside a registered plugin only adds the decorator to
 * that plugin's encapsulated child context, so sibling plugins
 * (customers, annual-docs, assistant, …) wouldn't see it. The decorator
 * lived in licensing.routes.ts originally — an encapsulated plugin
 * mounted under /license — and was therefore invisible to its callers:
 * every feature plugin that did `app.requireFeature(...)` crashed at
 * registration with "app.requireFeature is not a function". Decorating
 * the top-level instance makes it inherited by all child contexts.
 *
 * Call this from buildApp AFTER fastifyAuth + fastifyTenantPrisma (the
 * gate reads the caller's tenant license via `req.tenantCtx.prisma` at
 * request time) and BEFORE the feature routes that consume it.
 */

import { AuditLogRepository } from "@loan/db";
import { type FeatureFlag, loadPublicKeyPem } from "@loan/licensing";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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

export function decorateFeatureGate(app: FastifyInstance): void {
  // Public-key resolution happens once at registration time. Mutating
  // the env after boot won't re-load it; that's intentional — rotating
  // the key requires a restart for safety.
  const publicKey = loadPublicKeyPem();
  if (!publicKey) {
    app.log.warn(
      "License public key not configured (LICENSE_PUBLIC_KEY_PEM / LICENSE_PUBLIC_KEY_PATH). Running in grace mode — every license check will return NO_KEY.",
    );
  }

  // requireFeature(flag) — feature-gate preHandler factory. Builds a
  // per-request LicensingService against the caller's tenant schema,
  // so each tenant's license decides their own feature set. Upstream
  // route plugins must hook `app.resolveTenant` before any route that
  // uses requireFeature — every multi-tenant feature plugin already
  // does so as its second preHandler.
  app.decorate("requireFeature", (...flags: FeatureFlag[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      // Cache on the request so the same call in a multi-preHandler
      // chain doesn't re-verify the Ed25519 signature N times. Cheap
      // either way (microseconds), but keeping things tidy.
      const cache = req as {
        licenseCheck?: Awaited<ReturnType<LicensingService["loadCurrent"]>>;
      };
      let current = cache.licenseCheck;
      if (!current) {
        const prisma = req.tenantCtx.prisma;
        const svc = new LicensingService(
          prisma,
          new AuditLogRepository(prisma, req.user?.impersonatedBy),
          req.log,
          publicKey,
        );
        current = await svc.loadCurrent();
        cache.licenseCheck = current;
      }

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
}
