import type { FastifyReply, FastifyRequest } from "fastify";

import type { PlatformJwtPayload, PlatformService } from "./platform.service";
import {
  issueLicenseSchema,
  platformLoginSchema,
  provisionTenantSchema,
  revokeLicenseSchema,
} from "./schemas";

/**
 * HTTP adapter for /platform/*. Most routes require the platform JWT
 * (set by `platformAuthenticate` in routes.ts); login is the
 * exception that issues it.
 */
export class PlatformController {
  constructor(private readonly service: PlatformService) {}

  login = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = platformLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.login({ input: parsed.data });
    if (!result.ok) {
      // Same generic message for "no such email" and "wrong password"
      // to avoid leaking which platform-admin emails exist.
      return reply.code(401).send({
        error: "Unauthorized",
        message:
          result.kind === "Inactive"
            ? "Account inactive. Contact your administrator."
            : "Invalid email or password.",
      });
    }
    return { token: result.token, user: result.user };
  };

  listTenants = async () => this.service.listTenants();

  findTenant = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ) => {
    const row = await this.service.findTenant(req.params.slug);
    if (!row) return reply.code(404).send({ error: "NotFound" });
    return row;
  };

  provisionTenant = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = provisionTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const actor = platformActor(req);
    const result = await this.service.provisionTenant({
      input: parsed.data,
      actor,
    });
    if (!result.ok) {
      const code = result.kind === "SlugTaken" ? 409 : 500;
      return reply.code(code).send({
        error: result.kind,
        message: result.message,
      });
    }
    // Bundle the bootstrap credentials with the tenant payload when
    // multi-tenant provisioning produced fresh ones. The platform UI
    // surfaces them once with a copy button — they aren't recoverable
    // later (the password's plaintext form never gets persisted).
    return reply.code(201).send({
      ...result.tenant,
      bootstrapPassword: result.bootstrapPassword ?? null,
      bootstrapAdminEmail: result.bootstrapAdminEmail ?? null,
    });
  };

  retryProvisioning = async (
    req: FastifyRequest<{
      Params: { slug: string };
      Body: { adminEmail?: string; adminName?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const body = req.body ?? {};
    const result = await this.service.retryProvisioning({
      slug: req.params.slug,
      adminEmail: body.adminEmail,
      adminName: body.adminName,
      actor: platformActor(req),
    });
    if (!result.ok) {
      const code =
        result.kind === "NotFound"
          ? 404
          : result.kind === "ModeDisabled"
            ? 400
            : result.kind === "NotInProvisioning"
              ? 409
              : 500;
      return reply.code(code).send({
        error: result.kind,
        message: result.message,
      });
    }
    return {
      status: result.status,
      bootstrapPassword: result.bootstrapPassword,
      bootstrapAdminEmail: result.bootstrapAdminEmail,
    };
  };

  suspendTenant = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.setTenantStatus({
      slug: req.params.slug,
      status: "SUSPENDED",
      actor: platformActor(req),
    });
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.tenant;
  };

  restoreTenant = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.setTenantStatus({
      slug: req.params.slug,
      status: "ACTIVE",
      actor: platformActor(req),
    });
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.tenant;
  };

  archiveTenant = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await this.service.setTenantStatus({
      slug: req.params.slug,
      status: "ARCHIVED",
      actor: platformActor(req),
    });
    if (!result.ok) return reply.code(404).send({ error: "NotFound" });
    return result.tenant;
  };

  issueLicense = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = issueLicenseSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.issueLicense({
      input: parsed.data,
      actor: platformActor(req),
    });
    if (!result.ok) {
      const code = result.kind === "NoPrivateKey" ? 500 : 400;
      return reply.code(code).send({
        error: result.kind,
        message: result.message,
      });
    }
    // Return the token + a summary so the UI can show "issued, here's
    // the token to email to the tenant admin".
    return reply.code(201).send({
      token: result.token,
      payload: result.payload,
    });
  };

  listTenantLicenses = async (
    req: FastifyRequest<{ Params: { slug: string } }>,
  ) => {
    return this.service.listIssuedLicenses(req.params.slug);
  };

  revokeLicense = async (
    req: FastifyRequest<{ Params: { jti: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = revokeLicenseSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.revokeIssuedLicense({
      jti: req.params.jti,
      reason: parsed.data.reason,
      actor: platformActor(req),
    });
    if (!result.ok) {
      const code = result.kind === "NotFound" ? 404 : 409;
      return reply.code(code).send({
        error: result.kind,
        message: result.message,
      });
    }
    return result;
  };

  listAudit = async (
    req: FastifyRequest<{
      Querystring: { limit?: string; tenantSlug?: string; action?: string };
    }>,
  ) => {
    return this.service.listAudit({
      limit: req.query.limit ? Number(req.query.limit) : 100,
      tenantSlug: req.query.tenantSlug,
      action: req.query.action,
    });
  };
}

/** Pull the platform-side actor identity from the verified JWT. */
function platformActor(req: FastifyRequest): { id: string; email: string } {
  const payload = req.user as unknown as PlatformJwtPayload;
  return { id: payload.sub, email: payload.email };
}
