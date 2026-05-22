import { hashPassword, verifyPassword } from "@loan/auth";
import type { PrismaClient } from "@loan/db";
import {
  defaultFeaturesForTier,
  loadPrivateKeyPem,
  signLicense,
  TIER_SEATS,
  type FeatureFlag,
  type LicensePayload,
  type LicenseTier,
} from "@loan/licensing";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import type {
  IssueLicenseInput,
  PlatformLoginInput,
  ProvisionTenantInput,
} from "./schemas";

/**
 * Platform-console service. Distinct from the per-tenant services in
 * other features:
 *
 *   - `login`        — authenticates a PlatformUser, issues a JWT
 *                      with `platform: true` claim that tenant-side
 *                      routes will refuse.
 *   - `listTenants`  — read the Tenant catalog (lives in `public`).
 *   - `provisionTenant` — Phase 3a: insert the row + leave status as
 *                      PROVISIONING. Full schema provisioning lives in
 *                      Phase 2 and is a placeholder for now.
 *   - `issueLicense` — sign a license token via @loan/licensing's
 *                      private key, attach it to the Tenant row.
 *                      Replaces the CLI for production issuance.
 *   - `suspend / restore / archive` — Tenant.status mutations.
 *
 * Every mutating method writes a PlatformAuditLog row so the vendor
 * has a complete trail of who did what on the control plane.
 */

export interface PlatformJwtPayload {
  /** PlatformUser id. */
  sub: string;
  email: string;
  role: "PLATFORM_ADMIN" | "PLATFORM_SALES";
  /** Discriminator. Tenant routes reject any JWT with this true. */
  platform: true;
}

export type LoginResult =
  | {
      ok: true;
      token: string;
      user: { id: string; email: string; name: string; role: string };
    }
  | { ok: false; kind: "InvalidCredentials" | "Inactive" };

export type ProvisionResult =
  | {
      ok: true;
      tenant: { id: string; slug: string; name: string; status: string };
    }
  | { ok: false; kind: "SlugTaken" | "RepoError"; message: string };

export type IssueLicenseResult =
  | {
      ok: true;
      token: string;
      payload: LicensePayload;
    }
  | {
      ok: false;
      kind: "NoPrivateKey" | "BadExpiry" | "RepoError";
      message: string;
    };

export type RevokeLicenseResult =
  | { ok: true; jti: string; clearedSnapshot: boolean }
  | { ok: false; kind: "NotFound" | "AlreadyRevoked"; message: string };

export class PlatformService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly app: FastifyInstance,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ─── auth ──────────────────────────────────────────────────────────

  async login(args: { input: PlatformLoginInput }): Promise<LoginResult> {
    const user = await this.prisma.platformUser.findUnique({
      where: { email: args.input.email },
    });
    if (!user) return { ok: false, kind: "InvalidCredentials" };
    if (!user.active) return { ok: false, kind: "Inactive" };
    // @loan/auth's verifyPassword takes (hash, plain) — historical order.
    const ok = await verifyPassword(user.passwordHash, args.input.password);
    if (!ok) return { ok: false, kind: "InvalidCredentials" };

    await this.prisma.platformUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const payload: PlatformJwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      platform: true,
    };
    // 8 hour TTL — platform sessions are admin-level so we don't want
    // long-lived tokens lying around. No refresh token here; if you
    // disconnect for 8h, log in again.
    //
    // Cast to `unknown` then to the JWT payload type — @fastify/jwt's
    // type is locked to the tenant-side JwtPayload (role: UserRole),
    // but at runtime the library accepts any object. The
    // discriminator (`platform: true`) is what makes our payload
    // shape distinct from a tenant token.
    const token = this.app.jwt.sign(
      payload as unknown as Parameters<typeof this.app.jwt.sign>[0],
      { expiresIn: "8h" },
    );
    return {
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  /** Seed a default PLATFORM_ADMIN user when the table is empty. */
  async seedDefaultAdminIfEmpty(): Promise<void> {
    const count = await this.prisma.platformUser.count();
    if (count > 0) return;
    const email =
      process.env.PLATFORM_BOOTSTRAP_EMAIL ?? "platform@smartloan.local";
    const password =
      process.env.PLATFORM_BOOTSTRAP_PASSWORD ?? "ChangeMeNow!2026";
    await this.prisma.platformUser.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        name: "Platform Admin",
        role: "PLATFORM_ADMIN",
      },
    });
    this.log.warn(
      { email },
      "Bootstrapped default PLATFORM_ADMIN. Change the password immediately via the platform console.",
    );
  }

  // ─── tenants ───────────────────────────────────────────────────────

  async listTenants() {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
    });
  }

  async findTenant(slug: string) {
    return this.prisma.tenant.findUnique({ where: { slug } });
  }

  async provisionTenant(args: {
    input: ProvisionTenantInput;
    actor: { id: string; email: string };
  }): Promise<ProvisionResult> {
    const existing = await this.prisma.tenant.findUnique({
      where: { slug: args.input.slug },
    });
    if (existing) {
      return {
        ok: false,
        kind: "SlugTaken",
        message: `A tenant with slug "${args.input.slug}" already exists.`,
      };
    }
    try {
      const row = await this.prisma.tenant.create({
        data: {
          slug: args.input.slug,
          name: args.input.name,
          // Status stays PROVISIONING. Phase 2 provisioning (schema
          // create + migrations + seed) flips this to ACTIVE; until
          // then, a new row is a placeholder the platform console can
          // issue a license against, but no tenant API actually runs.
          status: "PROVISIONING",
        },
      });
      await this.audit({
        action: "PLATFORM_TENANT_PROVISION",
        actor: args.actor,
        tenantSlug: row.slug,
        payload: { name: row.name },
      });
      return {
        ok: true,
        tenant: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          status: row.status,
        },
      };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  async setTenantStatus(args: {
    slug: string;
    status: "ACTIVE" | "SUSPENDED" | "ARCHIVED";
    actor: { id: string; email: string };
  }) {
    const row = await this.prisma.tenant.findUnique({
      where: { slug: args.slug },
    });
    if (!row) return { ok: false as const, kind: "NotFound" as const };
    const updated = await this.prisma.tenant.update({
      where: { id: row.id },
      data: { status: args.status },
    });
    await this.audit({
      action: `PLATFORM_TENANT_${args.status}`,
      actor: args.actor,
      tenantSlug: row.slug,
      payload: { from: row.status, to: args.status },
    });
    return { ok: true as const, tenant: updated };
  }

  // ─── license issuance ──────────────────────────────────────────────

  async issueLicense(args: {
    input: IssueLicenseInput;
    actor: { id: string; email: string };
  }): Promise<IssueLicenseResult> {
    const privatePem = loadPrivateKeyPem();
    if (!privatePem) {
      return {
        ok: false,
        kind: "NoPrivateKey",
        message:
          "Platform private key not configured. Set LICENSE_PRIVATE_KEY_PEM or LICENSE_PRIVATE_KEY_PATH on the platform host.",
      };
    }

    const exp = Date.parse(args.input.expiresAt);
    if (Number.isNaN(exp) || exp <= Date.now()) {
      return {
        ok: false,
        kind: "BadExpiry",
        message: "expiresAt must be a future ISO timestamp.",
      };
    }
    const nbf = args.input.notBefore
      ? Date.parse(args.input.notBefore)
      : undefined;

    const tier = args.input.tier as LicenseTier;
    const features = (args.input.features ??
      defaultFeaturesForTier(tier)) as FeatureFlag[];
    const seats =
      args.input.seats !== undefined ? args.input.seats : TIER_SEATS[tier];

    const payload: LicensePayload = {
      v: 1,
      jti: randomUUID(),
      tenant: args.input.tenantName ?? args.input.tenantSlug,
      tier,
      features,
      iat: Date.now(),
      nbf,
      exp,
      seats,
      notes: args.input.notes,
    };

    try {
      const token = signLicense(payload, privatePem);

      // Persist the issued license so the console can show full
      // history per tenant (with revoke / re-send actions) without
      // scraping audit log payloads.
      await this.prisma.platformIssuedLicense.create({
        data: {
          jti: payload.jti,
          tenantSlug: args.input.tenantSlug,
          tenantName: args.input.tenantName ?? args.input.tenantSlug,
          tier,
          token,
          payload: payload as unknown as object,
          issuedAt: new Date(payload.iat),
          notBefore: nbf ? new Date(nbf) : null,
          expiresAt: new Date(exp),
          seats,
          notes: args.input.notes,
          issuedById: args.actor.id,
          issuedByEmail: args.actor.email,
        },
      });

      // Refresh the licenseSnapshot on the Tenant row so the
      // platform console's tenants list reflects the latest issuance
      // without waiting for the tenant API to phone home. The tenant
      // itself still has to paste the token to actually activate it
      // (that's by design — the platform doesn't auto-deploy tokens).
      await this.prisma.tenant.updateMany({
        where: { slug: args.input.tenantSlug },
        data: { licenseSnapshot: payload as unknown as object },
      });

      await this.audit({
        action: "PLATFORM_LICENSE_ISSUE",
        actor: args.actor,
        tenantSlug: args.input.tenantSlug,
        payload: {
          jti: payload.jti,
          tier,
          expiresAt: new Date(exp).toISOString(),
          featureCount: features.length,
        },
      });

      return { ok: true, token, payload };
    } catch (err) {
      return { ok: false, kind: "RepoError", message: (err as Error).message };
    }
  }

  /** History of issued licenses for a tenant, newest first. */
  async listIssuedLicenses(tenantSlug: string) {
    return this.prisma.platformIssuedLicense.findMany({
      where: { tenantSlug },
      orderBy: { issuedAt: "desc" },
    });
  }

  /**
   * Mark an issued license as revoked on the platform side. Important
   * caveat: this does NOT invalidate the signed token on tenant
   * instances. Until a CRL endpoint ships, revocation is bookkeeping
   * for the vendor + a trigger to clear the tenant's licenseSnapshot
   * so the platform console stops treating it as the current license.
   *
   * In practice, the workflow is: revoke → issue a fresh token with
   * tighter terms (or none) → ask the tenant to re-paste. The original
   * token's `exp` is the hard backstop.
   */
  async revokeIssuedLicense(args: {
    jti: string;
    reason?: string;
    actor: { id: string; email: string };
  }): Promise<RevokeLicenseResult> {
    const row = await this.prisma.platformIssuedLicense.findUnique({
      where: { jti: args.jti },
    });
    if (!row) {
      return {
        ok: false,
        kind: "NotFound",
        message: `No license with jti=${args.jti}`,
      };
    }
    if (row.revokedAt) {
      return {
        ok: false,
        kind: "AlreadyRevoked",
        message: `License revoked at ${row.revokedAt.toISOString()}`,
      };
    }

    await this.prisma.platformIssuedLicense.update({
      where: { id: row.id },
      data: {
        revokedAt: new Date(),
        revokedById: args.actor.id,
        revokedReason: args.reason,
      },
    });

    // If the revoked license is the one the Tenant row is currently
    // advertising (most recent issuance), clear the snapshot. The
    // tenants list will then show "no active license" and prompt the
    // operator to issue a fresh one.
    let clearedSnapshot = false;
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug: row.tenantSlug },
    });
    if (tenant?.licenseSnapshot) {
      const snapshot = tenant.licenseSnapshot as { jti?: string };
      if (snapshot.jti === args.jti) {
        await this.prisma.tenant.update({
          where: { id: tenant.id },
          data: { licenseSnapshot: null as never },
        });
        clearedSnapshot = true;
      }
    }

    await this.audit({
      action: "PLATFORM_LICENSE_REVOKE",
      actor: args.actor,
      tenantSlug: row.tenantSlug,
      payload: {
        jti: args.jti,
        reason: args.reason ?? null,
        clearedSnapshot,
      },
    });

    return { ok: true, jti: args.jti, clearedSnapshot };
  }

  // ─── audit ─────────────────────────────────────────────────────────

  async listAudit(
    args: {
      limit?: number;
      tenantSlug?: string;
      action?: string;
    } = {},
  ) {
    return this.prisma.platformAuditLog.findMany({
      where: {
        ...(args.tenantSlug ? { tenantSlug: args.tenantSlug } : {}),
        ...(args.action ? { action: args.action } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(args.limit ?? 100, 500),
    });
  }

  private async audit(args: {
    action: string;
    actor: { id: string; email: string };
    tenantSlug?: string;
    payload: object;
  }) {
    await this.prisma.platformAuditLog.create({
      data: {
        action: args.action,
        actorId: args.actor.id,
        actorEmail: args.actor.email,
        tenantSlug: args.tenantSlug,
        payload: args.payload as unknown as object,
      },
    });
  }
}
