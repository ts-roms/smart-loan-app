/**
 * Licensing routes — status + activate + deactivate.
 *
 * Phase 2: License rows live in each tenant's schema. Both the routes
 * here and the `app.requireFeature(...)` gate consult the calling
 * tenant's License via `req.tenantCtx.prisma`. The Ed25519 public key
 * is resolved once at boot — rotating it requires a restart.
 *
 * `admin.roles` gates the mutating routes since license state affects
 * which features the org has access to. The read route is open to any
 * authenticated user so the dashboard banner / status pill on every
 * page can show "X days until expiry".
 *
 * Layered: routes → controller → service → repo + audit.
 */

import { AuditLogRepository } from "@loan/db";
import { loadPublicKeyPem } from "@loan/licensing";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { routeSchema } from "../../lib/openapi";
import { LicensingController } from "./licensing.controller";
import { LicensingService } from "./licensing.service";
import {
  activateLicenseSchema,
  deactivateLicenseResponseSchema,
  licenseStatusResponseSchema,
} from "./schemas";

const TAGS = ["licensing"];

// NOTE: the `app.requireFeature(...)` decorator is registered at the
// root in app.ts via `fastifyFeatureGate` (see ./feature-gate.plugin).
// It must be a root-level fastify-plugin so every sibling feature route
// can use it; decorating it here (encapsulated under /license) made it
// invisible to callers and crashed boot.
declare module "fastify" {
  interface FastifyRequest {
    licensingServices?: { licensing: LicensingService };
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

  /*
   * `onRequest`, because `/activate` now carries a body schema and
   * Fastify validates between `onRequest` and `preHandler`. Left at
   * `preHandler` an anonymous POST with a malformed body would be told
   * its `token` was wrong instead of that it had no credentials.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const prisma = req.tenantCtx.prisma;
    req.licensingServices = {
      licensing: new LicensingService(
        prisma,
        new AuditLogRepository(prisma, req.user?.impersonatedBy),
        req.log,
        publicKey,
      ),
    };
  });

  const ctrl = new LicensingController();

  // Read endpoint — every authenticated user. The dashboard renders
  // a status banner on every page so this needs to be reachable
  // without admin.roles.
  app.get(
    "/status",
    {
      schema: routeSchema({
        summary:
          "Current licence state. Any authenticated user — the status " +
          "banner renders on every page. Only `status` is always " +
          "present; the licence details come with ACTIVE, a `message` " +
          "with everything else.",
        tags: TAGS,
        response: licenseStatusResponseSchema,
        errors: [401],
      }),
    },
    ctrl.status,
  );

  app.post(
    "/activate",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Install a signed licence token. Answers the resulting status, " +
          "always the ACTIVE shape. A token that fails verification is a " +
          "400, not a 403 — it is a bad payload, not a permission issue.",
        tags: TAGS,
        body: activateLicenseSchema,
        response: licenseStatusResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    ctrl.activate,
  );

  /*
   * No `body` schema on deactivate: the handler never reads `req.body`,
   * so attaching one would invent a request the route does not have and
   * reject the bodyless POST that works today.
   */
  app.post(
    "/deactivate",
    {
      preHandler: app.requirePermission("admin.roles"),
      schema: routeSchema({
        summary:
          "Revoke the active licence. Idempotent — with nothing active " +
          "it answers `revokedId: null` rather than 404, because the " +
          "caller asked for a state and got it. Takes no body.",
        tags: TAGS,
        response: deactivateLicenseResponseSchema,
        errors: [401, 403],
      }),
    },
    ctrl.deactivate,
  );
}
