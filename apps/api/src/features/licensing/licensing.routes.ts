/**
 * Licensing routes — status + activate + deactivate.
 *
 * `admin.roles` gates the mutating routes since license state
 * affects which features the org has access to. The read route is
 * open to any authenticated user so the dashboard banner /
 * status pill on every page can show "X days until expiry".
 *
 * Layered: routes → controller → service → repo + audit.
 */

import { AuditLogRepository } from "@loan/db";
import { loadPublicKeyPem } from "@loan/licensing";
import type { FastifyInstance } from "fastify";

import { LicensingController } from "./licensing.controller";
import { LicensingService } from "./licensing.service";

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
  // (Phase 1b feature-gate decorator) can consult it. The decorator
  // wraps the cache around the same loadCurrent() so we re-verify
  // exactly once per request that needs it.
  app.decorate("license", service);

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
