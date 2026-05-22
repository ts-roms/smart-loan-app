import { AuditLogRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

/**
 * Auth feature plugin. Owns every write path on /auth and every /me
 * read. Heavy layered split because every endpoint here is
 * security-critical and audit-coupled — see auth.service.ts for the
 * orchestration contracts.
 *
 * The service intentionally doesn't import Fastify: the JWT signer
 * and permission resolver are passed in as functions from this
 * composition root.
 */
export async function authRoutes(app: FastifyInstance) {
  // Infrastructure
  const audit = new AuditLogRepository(app.prisma);

  // Application — the service depends on prisma + audit + two
  // Fastify-decorated capabilities (jwt.sign + resolvePermissions).
  // Wrapping them in arrow functions keeps the service Fastify-agnostic.
  const service = new AuthService(
    app.prisma,
    audit,
    (payload, opts) => app.jwt.sign(payload, opts),
    (userId) => app.resolvePermissions(userId),
  );

  // Presentation
  const auth = new AuthController(service);

  // Tight rate limit on credential endpoints — defends against
  // credential stuffing and account-enumeration probes. Keyed on IP
  // via the global rate-limit plugin's default keyGenerator.
  const authThrottle = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };

  // ── Public credential endpoints ────────────────────────────────────
  app.post("/login", authThrottle, auth.login);
  app.post("/register", authThrottle, auth.register);
  app.post("/refresh", authThrottle, auth.refresh);
  app.post("/logout", auth.logout);

  // ── /me — authenticated identity surface ───────────────────────────
  app.get("/me", { preHandler: [app.authenticate] }, auth.me);

  // Personnel default signature — embedded into PDFs by the document
  // routes when ?sign=1 is set on the document download.
  app.get(
    "/me/signature",
    { preHandler: [app.authenticate] },
    auth.getSignature,
  );
  app.put(
    "/me/signature",
    { preHandler: [app.authenticate] },
    auth.setSignature,
  );
  app.delete(
    "/me/signature",
    { preHandler: [app.authenticate] },
    auth.clearSignature,
  );

  // Effective permission keys + roles. UI hides actions the user can't
  // perform — server-side requirePermission is the real gate.
  app.get(
    "/me/permissions",
    { preHandler: [app.authenticate] },
    auth.permissions,
  );

  // ── Notification bell state ────────────────────────────────────────
  //   GET  /me/notifications/state — returns { lastSeenAt, unseen }
  //   POST /me/notifications/seen  — advances lastSeenAt to now()
  app.get(
    "/me/notifications/state",
    { preHandler: [app.authenticate] },
    auth.notificationsState,
  );
  app.post(
    "/me/notifications/seen",
    { preHandler: [app.authenticate] },
    auth.markNotificationsSeen,
  );

  // ── 2FA (TOTP) ─────────────────────────────────────────────────────
  // Three-step flow:
  //   POST /me/2fa/setup    — generate a fresh secret + otpauth URI;
  //                           client renders a QR code
  //   POST /me/2fa/enable   — submit a TOTP code to prove the secret
  //                           was set up correctly; we persist + flip
  //                           totpEnabled, then return recovery codes
  //   POST /me/2fa/disable  — submit a current TOTP code to disable
  app.get(
    "/me/2fa/status",
    { preHandler: [app.authenticate] },
    auth.totpStatus,
  );
  app.post("/me/2fa/setup", { preHandler: [app.authenticate] }, auth.totpSetup);
  app.post(
    "/me/2fa/enable",
    { preHandler: [app.authenticate] },
    auth.totpEnable,
  );
  app.post(
    "/me/2fa/disable",
    { preHandler: [app.authenticate] },
    auth.totpDisable,
  );
}
