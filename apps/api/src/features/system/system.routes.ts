import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuditLogRepository } from "@loan/db";

import { routeSchema } from "../../lib/openapi";

import {
  brandingResponseSchema,
  brandingUpdateSchema,
  idlePolicyResponseSchema,
  idlePolicyUpdateResponseSchema,
  idlePolicyUpdateSchema,
  IDLE_TIMEOUT_MAX,
  IDLE_TIMEOUT_MIN,
  IDLE_WARNING_MAX,
  IDLE_WARNING_MIN,
  notificationProvidersResponseSchema,
  notificationProvidersUpdateResponseSchema,
  notificationProvidersUpdateSchema,
} from "./schemas";

const TAGS = ["system"];

/**
 * Mask a secret for safe display in the admin UI. Keeps the first 4
 * + last 4 characters so the operator can verify they pasted the
 * right key, redacting the middle. `null` stays `null` — nothing to
 * mask. Short strings (<12 chars) are fully redacted because there's
 * no safe prefix/suffix split.
 */
function maskSecret(s: string | null): string | null {
  if (s == null) return null;
  if (s.length < 12) return "••••••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * System-wide settings the operator can tweak at runtime without a
 * redeploy. Today: idle-then-logout policy + company branding.
 *
 * Phase 2: every read/write hits the per-request tenant client
 * (req.tenantCtx.prisma); the audit repo is built per-request too.
 */

declare module "fastify" {
  interface FastifyRequest {
    systemAuditRepo?: AuditLogRepository;
  }
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  /*
   * onRequest, not preHandler — routes in this group carry request
   * schemas, and Fastify validates at preValidation, BEFORE preHandler.
   * With `authenticate` at preHandler an unauthenticated caller PUTting
   * a malformed body got a 400 describing the schema instead of a 401.
   * See decision-rules.routes.ts for the full account.
   *
   * EVERY route here is authenticated, including the two GETs that take
   * no permission — this feature holds no liveness or readiness probe.
   * Those live in features/health, mounted separately and deliberately
   * open, and nothing in this file should be read as covering them.
   */
  app.addHook("onRequest", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.systemAuditRepo = new AuditLogRepository(
      req.tenantCtx.prisma,
      req.user?.impersonatedBy,
    );
  });

  // ── Idle-then-logout policy ────────────────────────────────────────

  /*
   * No `requirePermission` on this read, and that is intentional: every
   * signed-in session needs the idle policy to arm its own logout timer,
   * so gating it behind admin.system_config would break the shell for
   * everyone who is not an admin. Authenticated, unpermissioned — hence
   * a 401 in the spec but no 403.
   */
  app.get(
    "/idle-policy",
    {
      schema: routeSchema({
        summary:
          "The org-wide idle-then-logout policy, plus the bounds the " +
          "server enforces. Any signed-in caller — the shell arms its " +
          "timer from this.",
        tags: TAGS,
        response: idlePolicyResponseSchema,
        errors: [401],
      }),
    },
    async (req) => {
    // SystemConfig is a singleton row; upsert the defaults on first read
    // so a fresh install never returns nulls. Cheap; runs once per
    // database lifetime.
    const cfg = await req.tenantCtx.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: {
        idleTimeoutSeconds: true,
        idleWarningSeconds: true,
        updatedAt: true,
      },
    });
    return {
      idleTimeoutSeconds: cfg.idleTimeoutSeconds,
      idleWarningSeconds: cfg.idleWarningSeconds,
      updatedAt: cfg.updatedAt,
      bounds: {
        idleTimeoutSeconds: { min: IDLE_TIMEOUT_MIN, max: IDLE_TIMEOUT_MAX },
        idleWarningSeconds: { min: IDLE_WARNING_MIN, max: IDLE_WARNING_MAX },
      },
    };
  },
  );

  app.put(
    "/idle-policy",
    {
      preHandler: app.requirePermission("admin.system_config"),
      schema: routeSchema({
        summary:
          "Set the idle-then-logout policy. Answers the stored values " +
          "without the bounds block the GET carries.",
        tags: TAGS,
        body: idlePolicyUpdateSchema,
        response: idlePolicyUpdateResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const parsed = idlePolicyUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const updated = await req.tenantCtx.prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: {
          idleTimeoutSeconds: parsed.data.idleTimeoutSeconds,
          idleWarningSeconds: parsed.data.idleWarningSeconds,
          updatedById: req.user.sub,
        },
        create: {
          id: "singleton",
          idleTimeoutSeconds: parsed.data.idleTimeoutSeconds,
          idleWarningSeconds: parsed.data.idleWarningSeconds,
          updatedById: req.user.sub,
        },
        select: {
          idleTimeoutSeconds: true,
          idleWarningSeconds: true,
          updatedAt: true,
        },
      });
      await req.systemAuditRepo!.record({
        action: "SYSTEM_CONFIG_UPDATE",
        actorId: req.user.sub,
        targetType: "SystemConfig",
        payload: {
          scope: "idle-policy",
          idleTimeoutSeconds: parsed.data.idleTimeoutSeconds,
          idleWarningSeconds: parsed.data.idleWarningSeconds,
        },
      });
      return updated;
    },
  );

  // ── Branding (company name, logo, contact details) ─────────────────

  const BRANDING_SELECT = {
    companyName: true,
    companyLogoUrl: true,
    companyTagline: true,
    companyAddress: true,
    companyPhone: true,
    companyEmail: true,
    companyWebsite: true,
    updatedAt: true,
  } as const;

  /*
   * Unpermissioned for the same reason as /idle-policy: the sidebar,
   * the page title and every generated PDF need the company's name and
   * logo, so this has to be readable by whoever is signed in.
   */
  app.get(
    "/branding",
    {
      schema: routeSchema({
        summary:
          "Company branding — name, logo and contact details used in the " +
          "shell, page titles and PDF letterheads. Any signed-in caller.",
        tags: TAGS,
        response: brandingResponseSchema,
        errors: [401],
      }),
    },
    async (req) => {
      const cfg = await req.tenantCtx.prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: {},
        create: { id: "singleton" },
        select: BRANDING_SELECT,
      });
      return cfg;
    },
  );

  app.put(
    "/branding",
    {
      preHandler: app.requirePermission("admin.system_config"),
      schema: routeSchema({
        summary:
          "Update company branding. Send null (or an empty string) in a " +
          "field to clear it; companyName is required.",
        tags: TAGS,
        body: brandingUpdateSchema,
        response: brandingResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const parsed = brandingUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const empty = (v: string | null | undefined) =>
        v == null || v.trim() === "" ? null : v.trim();
      const updated = await req.tenantCtx.prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: {
          companyName: parsed.data.companyName.trim(),
          companyLogoUrl: empty(parsed.data.companyLogoUrl),
          companyTagline: empty(parsed.data.companyTagline),
          companyAddress: empty(parsed.data.companyAddress),
          companyPhone: empty(parsed.data.companyPhone),
          companyEmail: empty(parsed.data.companyEmail),
          companyWebsite: empty(parsed.data.companyWebsite),
          updatedById: req.user.sub,
        },
        create: {
          id: "singleton",
          companyName: parsed.data.companyName.trim(),
          companyLogoUrl: empty(parsed.data.companyLogoUrl),
          companyTagline: empty(parsed.data.companyTagline),
          companyAddress: empty(parsed.data.companyAddress),
          companyPhone: empty(parsed.data.companyPhone),
          companyEmail: empty(parsed.data.companyEmail),
          companyWebsite: empty(parsed.data.companyWebsite),
          updatedById: req.user.sub,
        },
        select: BRANDING_SELECT,
      });
      await req.systemAuditRepo!.record({
        action: "SYSTEM_CONFIG_UPDATE",
        actorId: req.user.sub,
        targetType: "SystemConfig",
        payload: { scope: "branding", ...parsed.data },
      });
      return updated;
    },
  );

  // ── Per-tenant notification providers (Twilio + SendGrid) ──────────

  /**
   * GET — returns the current provider config with SECRETS MASKED.
   * The operator can see "is Twilio configured? yes, ending in …XYZ"
   * without the API ever returning the full key over the wire after
   * the initial PUT. Avoids accidental exposure in browser history,
   * tab-share recordings, and screen captures.
   */
  app.get(
    "/notification-providers",
    {
      preHandler: app.requirePermission("admin.system_config"),
      schema: routeSchema({
        summary:
          "Per-tenant Twilio + SendGrid settings, with the secrets " +
          "MASKED — the full credentials are never returned after the PUT.",
        tags: TAGS,
        response: notificationProvidersResponseSchema,
        errors: [401, 403],
      }),
    },
    async (req) => {
      const cfg = await req.tenantCtx.prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: {},
        create: { id: "singleton" },
        select: {
          twilioAccountSid: true,
          twilioAuthToken: true,
          twilioFromNumber: true,
          sendgridApiKey: true,
          sendgridFromEmail: true,
          sendgridFromName: true,
          updatedAt: true,
        },
      });
      return {
        // SIDs aren't strictly secret but treating them consistently
        // with the auth token avoids "is THIS one safe?" confusion.
        twilioAccountSid: maskSecret(cfg.twilioAccountSid),
        twilioAuthToken: maskSecret(cfg.twilioAuthToken),
        // Sender numbers + emails are not secrets — return as-is.
        twilioFromNumber: cfg.twilioFromNumber,
        sendgridApiKey: maskSecret(cfg.sendgridApiKey),
        sendgridFromEmail: cfg.sendgridFromEmail,
        sendgridFromName: cfg.sendgridFromName,
        updatedAt: cfg.updatedAt,
        // Per-field "is set" flags so the UI can show a green check
        // without round-tripping the masked value into a regex.
        configured: {
          twilio: Boolean(
            cfg.twilioAccountSid && cfg.twilioAuthToken && cfg.twilioFromNumber,
          ),
          sendgrid: Boolean(cfg.sendgridApiKey && cfg.sendgridFromEmail),
        },
      };
    },
  );

  /**
   * PUT — accepts plaintext credentials and persists them. Each
   * field is independently nullable: send `null` to clear back to
   * the platform fallback for that field, omit it to leave it
   * unchanged. The audit row redacts the values (compliance trail
   * shouldn't contain credentials in plaintext).
   */
  app.put(
    "/notification-providers",
    {
      preHandler: app.requirePermission("admin.system_config"),
      schema: routeSchema({
        summary:
          "Store Twilio + SendGrid credentials. Answers { ok: true } and " +
          "an X-Refresh-Needed header — re-GET for the masked view.",
        tags: TAGS,
        body: notificationProvidersUpdateSchema,
        response: notificationProvidersUpdateResponseSchema,
        errors: [400, 401, 403],
      }),
    },
    async (req, reply) => {
      const parsed = notificationProvidersUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const empty = (v: string | null | undefined) =>
        v === null
          ? null
          : v === undefined
            ? undefined
            : v.trim() === ""
              ? null
              : v.trim();
      // Build the update payload only with fields the request
      // actually included — Prisma's `undefined` skips, `null`
      // clears. The schema mirrors that semantic.
      const data: Record<string, string | null> = {};
      if (parsed.data.twilioAccountSid !== undefined)
        data.twilioAccountSid = empty(parsed.data.twilioAccountSid) as
          string | null;
      if (parsed.data.twilioAuthToken !== undefined)
        data.twilioAuthToken = empty(parsed.data.twilioAuthToken) as
          string | null;
      if (parsed.data.twilioFromNumber !== undefined)
        data.twilioFromNumber = empty(parsed.data.twilioFromNumber) as
          string | null;
      if (parsed.data.sendgridApiKey !== undefined)
        data.sendgridApiKey = empty(parsed.data.sendgridApiKey) as
          string | null;
      if (parsed.data.sendgridFromEmail !== undefined)
        data.sendgridFromEmail = empty(parsed.data.sendgridFromEmail) as
          string | null;
      if (parsed.data.sendgridFromName !== undefined)
        data.sendgridFromName = empty(parsed.data.sendgridFromName) as
          string | null;

      await req.tenantCtx.prisma.systemConfig.upsert({
        where: { id: "singleton" },
        update: { ...data, updatedById: req.user.sub },
        create: { id: "singleton", ...data, updatedById: req.user.sub },
      });

      // Audit: capture WHICH fields changed (by key only, no values).
      // Compliance auditors trace "who edited Twilio creds when?"
      // without ever needing the credential itself.
      await req.systemAuditRepo!.record({
        action: "SYSTEM_CONFIG_UPDATE",
        actorId: req.user.sub,
        targetType: "SystemConfig",
        payload: {
          scope: "notification-providers",
          fieldsChanged: Object.keys(data),
          // Record whether each provider is now configured. Useful
          // for "the operator turned off SMS" without leaking which
          // creds were used.
          twilioConfigured: Boolean(
            (data.twilioAccountSid !== undefined
              ? data.twilioAccountSid
              : true) &&
            (data.twilioAuthToken !== undefined
              ? data.twilioAuthToken
              : true) &&
            (data.twilioFromNumber !== undefined
              ? data.twilioFromNumber
              : true),
          ),
          sendgridConfigured: Boolean(
            (data.sendgridApiKey !== undefined ? data.sendgridApiKey : true) &&
            (data.sendgridFromEmail !== undefined
              ? data.sendgridFromEmail
              : true),
          ),
        },
      });
      // Acknowledge only, and tell the client to re-read.
      //
      // This comment used to say the opposite — that the masked view
      // came back "so the UI can refresh from the response without an
      // extra round-trip" — while the code below has always sent
      // `{ ok: true }`. Corrected when the response was documented,
      // because a schema written from the old comment would have
      // published a body this route never sends.
      //
      // The round-trip is the point: re-GETting is what re-masks the
      // secrets, and echoing them back here would undo the property the
      // GET exists to maintain.
      return reply.code(200).header("X-Refresh-Needed", "1").send({ ok: true });
    },
  );
}
