import { hashPassword, verifyPassword } from "@loan/auth";
import type {
  AuditLogRepository,
  PrismaClient,
  User,
  UserRole,
} from "@loan/db";
import { authenticator } from "otplib";

import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_MS,
  TOTP_ISSUER,
  generateRecoveryCodes,
  generateRefreshToken,
  hashRecoveryCode,
  hashRefreshToken,
} from "./helpers";
import type { LoginInput, RegisterInput, TotpCodeInput } from "./schemas";

// Standard TOTP: 30-second window, 6-digit codes, ±1 step tolerance
// for clock skew. Matches Google Authenticator / Authy / 1Password
// defaults. Set once at module load, not per call.
authenticator.options = { window: 1, step: 30 };

/**
 * Function signature for the JWT signer the controller passes in. We
 * type it minimally so the service doesn't import Fastify or
 * @fastify/jwt — both stay in the composition root (index.ts).
 */
export type JwtSigner = (
  payload: { sub: string; email: string; role: UserRole },
  opts: { expiresIn: string },
) => string;

/**
 * Function signature for the permission resolver decorated by the
 * RBAC plugin onto the Fastify instance. Returns the union of the
 * user's permission keys across their assigned roles.
 */
export type PermissionResolver = (userId: string) => Promise<Set<string>>;

/** Pair returned by issueTokens — both shapes the client uses. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/** Public-facing user shape included alongside tokens on login/register/refresh. */
export interface UserDigest {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/** Login outcomes — discriminated so the controller maps to HTTP codes. */
export type LoginResult =
  | { ok: true; tokens: TokenPair; user: UserDigest }
  | { ok: false; kind: "InvalidCredentials" }
  | { ok: false; kind: "Invalid2faCode" }
  | { ok: false; kind: "InvalidRecoveryCode" }
  | { ok: false; kind: "Requires2fa" };

export type RegisterResult =
  | { ok: true; tokens: TokenPair; user: UserDigest }
  | { ok: false; kind: "EmailExists" };

export type RefreshResult =
  | { ok: true; tokens: TokenPair; user: UserDigest }
  | { ok: false; kind: "InvalidToken" }
  | { ok: false; kind: "Expired" }
  | { ok: false; kind: "AccountDisabled" }
  | { ok: false; kind: "ReuseDetected" };

export type TotpSetupResult =
  | { ok: true; secret: string; otpauth: string }
  | { ok: false; kind: "NotFound" }
  | { ok: false; kind: "AlreadyEnabled" };

export type TotpEnableResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; kind: "NotSetup" }
  | { ok: false; kind: "InvalidCode" };

export type TotpDisableResult =
  | { ok: true }
  | { ok: false; kind: "NotEnabled" }
  | { ok: false; kind: "InvalidCode" };

/**
 * AuthService — owns every write path on /auth and every /me read.
 *
 * Security-critical contracts:
 *   • Passwords are argon2id-hashed (via @loan/auth); raw passwords
 *     never leave the input. The service compares hashes with the
 *     time-constant verify from @loan/auth.
 *   • Refresh tokens are persisted as SHA-256 — raw tokens never
 *     touch the DB. Reuse of a rotated token nukes the whole family
 *     of refresh tokens for that user (theft detection).
 *   • 2FA codes go through `authenticator.verify` with a 30-second
 *     window and ±1 step tolerance. Recovery codes are single-use
 *     SHA-256 hashes.
 *   • Every state-changing action (TOTP enable / disable, recovery-
 *     code use, signature save / clear, refresh-token reuse) writes
 *     an AuditEvent row.
 *
 * The service never imports Fastify. The JWT signer and permission
 * resolver are passed in as functions; the controller is the bridge
 * between this and the HTTP layer.
 */
export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogRepository,
    private readonly signJwt: JwtSigner,
    private readonly resolvePermissions: PermissionResolver,
  ) {}

  // ── Token issuance ─────────────────────────────────────────────────

  /**
   * Issue a fresh access + refresh token pair for the given user.
   * `replacesId` lets callers thread the rotation chain — the new row
   * records that it supersedes the old one, which is the breadcrumb
   * theft detection reads on reuse.
   */
  private async issueTokens(
    user: User,
    opts: { replacesId?: string } = {},
  ): Promise<TokenPair> {
    const accessToken = this.signJwt(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: ACCESS_TOKEN_TTL },
    );
    const { raw, hash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const stored = await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt },
    });
    if (opts.replacesId) {
      await this.prisma.refreshToken.update({
        where: { id: opts.replacesId },
        data: { replacedById: stored.id },
      });
    }
    return {
      accessToken,
      refreshToken: raw,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    };
  }

  // ── Login + register + refresh + logout ────────────────────────────

  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    if (!user || !user.active) return { ok: false, kind: "InvalidCredentials" };

    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) return { ok: false, kind: "InvalidCredentials" };

    // 2FA gate — when the user has TOTP enabled, demand either a TOTP
    // code or a recovery code. Returning Requires2fa tells the client
    // to re-prompt with a code field, not treat the password as wrong.
    if (user.totpEnabled && user.totpSecret) {
      if (input.totpCode) {
        const valid = authenticator.verify({
          token: input.totpCode,
          secret: user.totpSecret,
        });
        if (!valid) return { ok: false, kind: "Invalid2faCode" };
      } else if (input.recoveryCode) {
        const codeHash = hashRecoveryCode(input.recoveryCode);
        if (!user.totpRecoveryCodes.includes(codeHash)) {
          return { ok: false, kind: "InvalidRecoveryCode" };
        }
        // Single-use — strike it off the list.
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            totpRecoveryCodes: user.totpRecoveryCodes.filter(
              (c) => c !== codeHash,
            ),
          },
        });
        await this.audit.record({
          action: "TOTP_RECOVERY_USED",
          actorId: user.id,
          targetType: "User",
          targetId: user.id,
          payload: { remaining: user.totpRecoveryCodes.length - 1 },
        });
      } else {
        return { ok: false, kind: "Requires2fa" };
      }
    }

    const tokens = await this.issueTokens(user);
    return { ok: true, tokens, user: digest(user) };
  }

  async register(input: RegisterInput): Promise<RegisterResult> {
    const exists = await this.prisma.user.findUnique({
      where: { email: input.email },
    });
    if (exists) return { ok: false, kind: "EmailExists" };

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        role: "CUSTOMER",
      },
    });
    const tokens = await this.issueTokens(user);
    return { ok: true, tokens, user: digest(user) };
  }

  /**
   * Exchange a refresh token for a new access+refresh pair. The
   * presented token is rotated — its row is revoked and a new row is
   * created. Re-use of an already-revoked token is the theft signal:
   * we revoke every active refresh token for that user.
   */
  async refresh(refreshToken: string): Promise<RefreshResult> {
    const hash = hashRefreshToken(refreshToken);
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
    });
    if (!row) return { ok: false, kind: "InvalidToken" };

    if (row.revokedAt) {
      // Re-use of a rotated token — assume theft. Nuke the whole family.
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record({
        action: "REFRESH_TOKEN_REUSE_DETECTED",
        actorId: row.userId,
        targetType: "User",
        targetId: row.userId,
        payload: { tokenId: row.id },
      });
      return { ok: false, kind: "ReuseDetected" };
    }
    if (row.expiresAt < new Date()) return { ok: false, kind: "Expired" };

    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
    });
    if (!user || !user.active) return { ok: false, kind: "AccountDisabled" };

    // Rotate: revoke the presented token, issue a new pair.
    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    const tokens = await this.issueTokens(user, { replacesId: row.id });
    return { ok: true, tokens, user: digest(user) };
  }

  /**
   * Logout — revoke the presented refresh token. Best-effort: we
   * silently succeed even if the token is unknown so we don't leak
   * validity to an attacker probing the endpoint.
   */
  async logout(refreshToken: string): Promise<void> {
    const hash = hashRefreshToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ── /me — identity + permissions ───────────────────────────────────

  async me(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        createdAt: true,
      },
    });
  }

  async getSignature(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { defaultSignatureUrl: true, signatureSavedAt: true },
    });
    if (!user) return null;
    return {
      signatureUrl: user.defaultSignatureUrl,
      savedAt: user.signatureSavedAt,
    };
  }

  async setSignature(userId: string, signatureUrl: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { defaultSignatureUrl: signatureUrl, signatureSavedAt: new Date() },
      select: { defaultSignatureUrl: true, signatureSavedAt: true },
    });
    await this.audit.record({
      action: "USER_SIGNATURE_SAVE",
      actorId: userId,
      targetType: "User",
      targetId: userId,
      payload: { signatureUrl },
    });
    return {
      signatureUrl: user.defaultSignatureUrl,
      savedAt: user.signatureSavedAt,
    };
  }

  async clearSignature(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { defaultSignatureUrl: null, signatureSavedAt: null },
    });
    await this.audit.record({
      action: "USER_SIGNATURE_CLEAR",
      actorId: userId,
      targetType: "User",
      targetId: userId,
      payload: {},
    });
    return {
      signatureUrl: null as string | null,
      savedAt: null as Date | null,
    };
  }

  /**
   * Permission keys + role list for the current user. The web app uses
   * this to hide actions the user lacks — the real authorisation gate
   * is always the server-side requirePermission middleware.
   */
  async permissions(userId: string) {
    const keys = await this.resolvePermissions(userId);
    const assignments = await this.prisma.userRoleAssignment.findMany({
      where: { userId },
      include: { role: true },
    });
    return {
      permissions: [...keys].sort(),
      roles: assignments.map((a) => ({
        key: a.role.key,
        name: a.role.name,
        system: a.role.system,
      })),
    };
  }

  // ── Notification bell state ────────────────────────────────────────

  async notificationsState(userId: string) {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lastSeenNotificationAt: true },
    });
    if (!me) return null;
    // Count notifications created strictly after the cursor. When
    // there's no cursor yet (brand-new account) treat *everything* as
    // unseen — better than silently dropping the count to zero.
    const where = me.lastSeenNotificationAt
      ? { createdAt: { gt: me.lastSeenNotificationAt } }
      : {};
    const unseen = await this.prisma.notification.count({ where });
    return { lastSeenAt: me.lastSeenNotificationAt, unseen };
  }

  async markNotificationsSeen(userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenNotificationAt: new Date() },
      select: { lastSeenNotificationAt: true },
    });
    return { lastSeenAt: updated.lastSeenNotificationAt, unseen: 0 };
  }

  // ── 2FA (TOTP) ─────────────────────────────────────────────────────

  async totpStatus(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpEnabled: true, totpRecoveryCodes: true },
    });
    if (!u) return null;
    return {
      enabled: u.totpEnabled,
      recoveryCodesRemaining: u.totpRecoveryCodes.length,
    };
  }

  /**
   * Generate a fresh TOTP secret + otpauth URI. The client renders the
   * URI as a QR code. We stash the secret on the user row with
   * totpEnabled=false; /enable confirms by submitting a code derived
   * from the same secret.
   */
  async totpSetup(userId: string): Promise<TotpSetupResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, totpEnabled: true },
    });
    if (!user) return { ok: false, kind: "NotFound" };
    if (user.totpEnabled) return { ok: false, kind: "AlreadyEnabled" };

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, TOTP_ISSUER, secret);
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: secret, totpEnabled: false },
    });
    return { ok: true, secret, otpauth };
  }

  /**
   * Verify the submitted code against the stashed secret. On success
   * flip totpEnabled, mint 10 single-use recovery codes (display them
   * to the user once; only the hashes are persisted), and audit the
   * enable event.
   */
  async totpEnable(
    userId: string,
    input: TotpCodeInput,
  ): Promise<TotpEnableResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user?.totpSecret) return { ok: false, kind: "NotSetup" };

    const valid = authenticator.verify({
      token: input.code,
      secret: user.totpSecret,
    });
    if (!valid) return { ok: false, kind: "InvalidCode" };

    const { codes, hashes } = generateRecoveryCodes(10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true, totpRecoveryCodes: hashes },
    });
    await this.audit.record({
      action: "TOTP_ENABLED",
      actorId: userId,
      targetType: "User",
      targetId: userId,
      payload: {},
    });
    return { ok: true, recoveryCodes: codes };
  }

  /**
   * Disable 2FA — requires a fresh TOTP code to prove the user is the
   * legitimate holder of the secret (defends against an attacker
   * who's hijacked a session but doesn't have the authenticator app).
   */
  async totpDisable(
    userId: string,
    input: TotpCodeInput,
  ): Promise<TotpDisableResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpSecret: true, totpEnabled: true },
    });
    if (!user?.totpEnabled || !user.totpSecret) {
      return { ok: false, kind: "NotEnabled" };
    }
    const valid = authenticator.verify({
      token: input.code,
      secret: user.totpSecret,
    });
    if (!valid) return { ok: false, kind: "InvalidCode" };

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: [] },
    });
    await this.audit.record({
      action: "TOTP_DISABLED",
      actorId: userId,
      targetType: "User",
      targetId: userId,
      payload: {},
    });
    return { ok: true };
  }
}

/** Public user shape returned alongside tokens. Hides sensitive fields. */
function digest(user: User): UserDigest {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
