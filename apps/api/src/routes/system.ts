import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AuditLogRepository } from "@loan/db";

/**
 * System-wide settings the operator can tweak at runtime without a
 * redeploy. Today: idle-then-logout policy. Future home for other
 * cross-cutting toggles (session length, password rotation, etc.).
 *
 * Authorization:
 *   • GET  — any authenticated user can read (the frontend needs the
 *            values to wire its idle hook).
 *   • PUT  — `admin.system_config` permission required.
 *
 * Why bounds (15s..3600s): an idle threshold below ~15s is unusable in
 * practice (a single Slack notification toggles the tab and dings the
 * counter), and above 1h defeats the security intent. The frontend
 * mirrors these bounds in the settings UI.
 */

// Bounds match the schema's Int width and the UX constraints noted above.
const IDLE_TIMEOUT_MIN = 15;
const IDLE_TIMEOUT_MAX = 3600;
const IDLE_WARNING_MIN = 10;
const IDLE_WARNING_MAX = 600;

const idlePolicyUpdateSchema = z.object({
  idleTimeoutSeconds: z
    .number()
    .int()
    .min(IDLE_TIMEOUT_MIN)
    .max(IDLE_TIMEOUT_MAX),
  idleWarningSeconds: z
    .number()
    .int()
    .min(IDLE_WARNING_MIN)
    .max(IDLE_WARNING_MAX),
});

// Branding: name is required + sized for sidebar; everything else is optional.
// `null` (vs. undefined) is treated as "clear the field" — convenient for the UI
// to send when a user blanks out an input.
const brandingUpdateSchema = z.object({
  companyName: z.string().min(1).max(80),
  companyLogoUrl: z.string().max(500).nullable().optional(),
  companyTagline: z.string().max(120).nullable().optional(),
  companyAddress: z.string().max(500).nullable().optional(),
  companyPhone: z.string().max(40).nullable().optional(),
  companyEmail: z.string().email().max(120).nullable().optional(),
  companyWebsite: z.string().max(200).nullable().optional(),
});

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const audit = new AuditLogRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  // ── Idle-then-logout policy ────────────────────────────────────────

  app.get("/idle-policy", async () => {
    // SystemConfig is a singleton row; upsert the defaults on first read
    // so a fresh install never returns nulls. Cheap; runs once per
    // database lifetime.
    const cfg = await app.prisma.systemConfig.upsert({
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
      const updated = await app.prisma.systemConfig.upsert({
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
      // Audit so policy drift is auditable. The audit drawer surfaces
      // SYSTEM_CONFIG_UPDATE rows from the navbar.
      await audit.record({
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

  // Branding fields the GET response includes — kept narrow on purpose
  // so the bell endpoint doesn't accidentally leak equity totals.
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

  app.get("/branding", async () => {
    const cfg = await app.prisma.systemConfig.upsert({
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
      // Map "" → null for optional fields so blanking an input clears
      // the column rather than storing a literal empty string (which the
      // UI would then render as a zero-width tagline).
      const empty = (v: string | null | undefined) =>
        v == null || v.trim() === "" ? null : v.trim();
      const updated = await app.prisma.systemConfig.upsert({
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
      await audit.record({
        action: "SYSTEM_CONFIG_UPDATE",
        actorId: req.user.sub,
        targetType: "SystemConfig",
        payload: { scope: "branding", ...parsed.data },
      });
      return updated;
    },
  );
}
