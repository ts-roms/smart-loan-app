import type { AuditLogRepository, PrismaClient } from "@loan/db";
import {
  type FeatureFlag,
  type LicensePayload,
  type LicenseTier,
  verifyLicense,
} from "@loan/licensing";
import type { FastifyBaseLogger } from "fastify";

import type { ActivateLicenseInput } from "./schemas";

/**
 * License lifecycle service.
 *
 *   - `loadCurrent()` is called on boot AND on every status check. It
 *     finds the latest non-revoked, non-expired row in the License
 *     table and re-verifies its token against the platform public key.
 *     The token is the source of truth — DB columns are denormalized
 *     copies used for fast queries, but any mismatch (signature fails,
 *     payload-vs-columns drift) treats the license as invalid.
 *
 *   - `activate()` accepts a fresh token, verifies it, and upserts
 *     into the License table. Upsert on `jti` means re-pasting the
 *     same token is a no-op rather than an error — the operator can
 *     paste the renewal early without first revoking the existing.
 *
 *   - `deactivate()` marks the current license revoked. The instance
 *     drops to grace mode immediately.
 *
 * The public key arrives via the constructor; the boot plugin handles
 * the env / file resolution and surfaces a friendly "no key configured"
 * banner if neither is set.
 */

export type CurrentLicenseStatus =
  | {
      ok: true;
      /** DB row id of the active license. */
      id: string;
      payload: LicensePayload;
      /** Computed: ms until expiry. Negative = already expired. */
      msUntilExpiry: number;
    }
  | {
      ok: false;
      kind: "NoneActive" | "Expired" | "Tampered" | "NoKeyConfigured";
      message: string;
      /** If a row exists but failed verification, surface its id so
       * the operator can deactivate + re-activate. */
      id?: string;
    };

export type ActivateResult =
  | { ok: true; status: Extract<CurrentLicenseStatus, { ok: true }> }
  | {
      ok: false;
      kind: "VerifyFailed" | "AlreadyActive" | "NoKeyConfigured" | "RepoError";
      message: string;
    };

export class LicensingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogRepository,
    private readonly log: FastifyBaseLogger,
    /**
     * PEM-encoded Ed25519 public key. Null = no key configured;
     * service returns NoKeyConfigured for every call so the operator
     * sees a clear "we can't verify anything until you set
     * LICENSE_PUBLIC_KEY_*" message instead of "BadSignature".
     */
    private readonly publicKeyPem: string | null,
  ) {}

  /**
   * Read the current license row, re-verify its token, and return the
   * caller's view. Cheap enough to call on every /license/status GET
   * — the heavy crypto is Ed25519 verify which is microseconds on
   * modern hardware.
   */
  async loadCurrent(): Promise<CurrentLicenseStatus> {
    if (!this.publicKeyPem) {
      return {
        ok: false,
        kind: "NoKeyConfigured",
        message:
          "LICENSE_PUBLIC_KEY_PEM / LICENSE_PUBLIC_KEY_PATH is not set. Configure it before activating a license.",
      };
    }
    const row = await this.prisma.license.findFirst({
      where: { revokedAt: null },
      orderBy: { activatedAt: "desc" },
    });
    if (!row) {
      return {
        ok: false,
        kind: "NoneActive",
        message:
          "No license activated. Paste a license token to enable the app.",
      };
    }
    const result = verifyLicense(row.token, this.publicKeyPem);
    if (!result.ok) {
      // We persist the verification failure in the response so the UI
      // can show "license file looks tampered — re-paste" instead of
      // "you have no license" (which would be misleading; there IS a
      // row, it's just unverifiable now).
      const kind = result.kind === "Expired" ? "Expired" : "Tampered";
      return {
        ok: false,
        kind,
        message: result.message,
        id: row.id,
      };
    }
    return {
      ok: true,
      id: row.id,
      payload: result.payload,
      msUntilExpiry: result.payload.exp - Date.now(),
    };
  }

  /**
   * Verify + persist a pasted token. The verify pass is identical to
   * `loadCurrent` so we can never end up with a row whose signature
   * doesn't validate.
   *
   * On success, the previously-active license (if any) is left in
   * place but eclipsed by `activatedAt` ordering — the new row wins
   * on subsequent loads. We don't auto-revoke the old row so the
   * audit history shows the overlap.
   */
  async activate(args: {
    input: ActivateLicenseInput;
    actorId: string;
  }): Promise<ActivateResult> {
    if (!this.publicKeyPem) {
      return {
        ok: false,
        kind: "NoKeyConfigured",
        message:
          "Cannot verify license: no public key configured. Set LICENSE_PUBLIC_KEY_PEM or LICENSE_PUBLIC_KEY_PATH.",
      };
    }
    const verified = verifyLicense(args.input.token, this.publicKeyPem);
    if (!verified.ok) {
      return {
        ok: false,
        kind: "VerifyFailed",
        message: verified.message,
      };
    }
    const payload = verified.payload;

    try {
      const row = await this.prisma.license.upsert({
        where: { jti: payload.jti },
        create: {
          token: args.input.token,
          jti: payload.jti,
          tenantName: payload.tenant,
          tier: payload.tier,
          // Prisma's Json column input type doesn't accept an interface
          // with optional members. The double assertion is load-bearing:
          // remove it and tsc fails with "Type 'LicensePayload' is not
          // assignable to type 'JsonNull | InputJsonValue'". The lint rule
          // only inspects the outer `as object` and calls it redundant.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          payload: payload as unknown as object,
          issuedAt: new Date(payload.iat),
          notBefore: payload.nbf ? new Date(payload.nbf) : null,
          expiresAt: new Date(payload.exp),
          seats: payload.seats,
          notes: payload.notes ?? null,
          activatedAt: new Date(),
          activatedById: args.actorId,
        },
        update: {
          // Re-paste of the same token (e.g. operator hit the button
          // twice or pasted the same renewal). Clear any prior revoke
          // and refresh the activatedAt so this becomes the current
          // license again.
          token: args.input.token,
          activatedAt: new Date(),
          activatedById: args.actorId,
          revokedAt: null,
          revokedById: null,
        },
      });
      await this.audit.record({
        action: "LICENSE_ACTIVATE",
        actorId: args.actorId,
        targetType: "License",
        targetId: row.id,
        payload: {
          jti: payload.jti,
          tenant: payload.tenant,
          tier: payload.tier,
          expiresAt: new Date(payload.exp).toISOString(),
        },
      });
      this.log.info(
        { jti: payload.jti, tenant: payload.tenant, tier: payload.tier },
        "License activated",
      );
      return {
        ok: true,
        status: {
          ok: true,
          id: row.id,
          payload,
          msUntilExpiry: payload.exp - Date.now(),
        },
      };
    } catch (err) {
      return {
        ok: false,
        kind: "RepoError",
        message: (err as Error).message,
      };
    }
  }

  /**
   * Mark the currently-active license revoked. Idempotent — calling
   * deactivate when nothing is active is not an error.
   */
  async deactivate(args: {
    actorId: string;
  }): Promise<{ ok: true; revokedId: string | null }> {
    const current = await this.prisma.license.findFirst({
      where: { revokedAt: null },
      orderBy: { activatedAt: "desc" },
    });
    if (!current) return { ok: true, revokedId: null };

    await this.prisma.license.update({
      where: { id: current.id },
      data: { revokedAt: new Date(), revokedById: args.actorId },
    });
    await this.audit.record({
      action: "LICENSE_DEACTIVATE",
      actorId: args.actorId,
      targetType: "License",
      targetId: current.id,
      payload: { jti: current.jti, tenant: current.tenantName },
    });
    this.log.info(
      { jti: current.jti, tenant: current.tenantName },
      "License deactivated",
    );
    return { ok: true, revokedId: current.id };
  }
}

/**
 * Public-shape projection used by GET /license/status. Strips fields
 * the tenant doesn't need (the full token, internal DB id) and adds
 * computed convenience values for the UI.
 */
export interface LicenseStatusPayload {
  status: "ACTIVE" | "EXPIRED" | "TAMPERED" | "NONE" | "NO_KEY";
  tenant?: string;
  tier?: LicenseTier;
  features?: FeatureFlag[];
  seats?: number;
  issuedAt?: string;
  notBefore?: string;
  expiresAt?: string;
  notes?: string;
  /** Days until expiry (rounded). Negative means already past. */
  daysUntilExpiry?: number;
  /** Human-readable reason when status is non-ACTIVE. */
  message?: string;
}

export function toStatusPayload(
  result: CurrentLicenseStatus,
): LicenseStatusPayload {
  if (result.ok) {
    return {
      status: "ACTIVE",
      tenant: result.payload.tenant,
      tier: result.payload.tier,
      features: result.payload.features,
      seats: result.payload.seats,
      issuedAt: new Date(result.payload.iat).toISOString(),
      notBefore: result.payload.nbf
        ? new Date(result.payload.nbf).toISOString()
        : undefined,
      expiresAt: new Date(result.payload.exp).toISOString(),
      notes: result.payload.notes,
      daysUntilExpiry: Math.floor(result.msUntilExpiry / (24 * 60 * 60 * 1000)),
    };
  }
  const statusMap = {
    NoneActive: "NONE",
    Expired: "EXPIRED",
    Tampered: "TAMPERED",
    NoKeyConfigured: "NO_KEY",
  } as const;
  return {
    status: statusMap[result.kind],
    message: result.message,
  };
}
