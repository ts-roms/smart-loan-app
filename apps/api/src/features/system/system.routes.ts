import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuditLogRepository } from "@loan/db";

import {
  brandingUpdateSchema,
  idlePolicyUpdateSchema,
  IDLE_TIMEOUT_MAX,
  IDLE_TIMEOUT_MIN,
  IDLE_WARNING_MAX,
  IDLE_WARNING_MIN,
} from "./schemas";

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
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.resolveTenant);
  app.addHook("preHandler", async (req: FastifyRequest) => {
    req.systemAuditRepo = new AuditLogRepository(
      req.tenantCtx.prisma,
      req.user?.impersonatedBy,
    );
  });

  // ── Idle-then-logout policy ────────────────────────────────────────

  app.get("/idle-policy", async (req) => {
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
  });

  app.put(
    "/idle-policy",
    { preHandler: app.requirePermission("admin.system_config") },
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

  app.get("/branding", async (req) => {
    const cfg = await req.tenantCtx.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: BRANDING_SELECT,
    });
    return cfg;
  });

  app.put(
    "/branding",
    { preHandler: app.requirePermission("admin.system_config") },
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
}
