import { hashPassword, verifyPassword } from '@loan/auth';
import { AuditLogRepository } from '@loan/db';
import { authenticator } from 'otplib';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import { z } from 'zod';

// Standard TOTP: 30-second window, 6-digit codes, ±1 step tolerance for
// clock skew. Matches Google Authenticator / Authy / 1Password defaults.
authenticator.options = { window: 1, step: 30 };

const TOTP_ISSUER = process.env.TOTP_ISSUER ?? 'SmartLoan';

const ACCESS_TOKEN_TTL = '24h';
/** Refresh tokens are valid for 30 days. */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Generate an opaque refresh token. 64 random bytes → 88 base64url chars.
 * The raw token is returned to the client; only its SHA-256 is persisted.
 */
function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(64).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Optional TOTP code; required when the user has totpEnabled = true. */
  totpCode: z.string().regex(/^\d{6}$/).optional(),
  /** Single-use recovery code (8 alphanumeric chars). Lockout escape hatch. */
  recoveryCode: z.string().min(1).max(40).optional(),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120),
});

const saveSignatureSchema = z.object({
  /** URL returned by /uploads-api/signatures upload. */
  signatureUrl: z.string().min(1).max(500),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  const audit = new AuditLogRepository(app.prisma);

  // Tight rate limit on credential endpoints — defends against credential
  // stuffing and account-enumeration probes. Keyed on IP via the global
  // rate-limit plugin's default keyGenerator.
  const authThrottle = {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  };

  /**
   * Issue a fresh access + refresh token pair for the given user. The
   * access token is a short-lived JWT; the refresh token is a random
   * opaque string persisted (hashed) so we can rotate / revoke it.
   * `replacesId` lets callers thread the rotation chain (refresh flow).
   */
  async function issueTokens(
    user: User,
    opts: { replacesId?: string } = {},
  ) {
    const accessToken = app.jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: ACCESS_TOKEN_TTL },
    );
    const { raw, hash } = generateRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
    const stored = await app.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hash,
        expiresAt,
      },
    });
    if (opts.replacesId) {
      // Mark the old token as replaced. We don't revoke it here because
      // `/auth/refresh` already did that — replacedById is the rotation
      // breadcrumb used for theft detection on re-use.
      await app.prisma.refreshToken.update({
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

  app.post('/login', authThrottle, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const user = await app.prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || !user.active) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }
    const ok = await verifyPassword(user.passwordHash, parsed.data.password);
    if (!ok) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    // 2FA enforcement: if the user has 2FA on, demand either a TOTP code
    // or a recovery code. Returning 401 with `requires2fa` tells the
    // client to re-prompt with a code field rather than treating the
    // password as wrong.
    if (user.totpEnabled && user.totpSecret) {
      if (parsed.data.totpCode) {
        const valid = authenticator.verify({
          token: parsed.data.totpCode,
          secret: user.totpSecret,
        });
        if (!valid) {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Invalid 2FA code',
            requires2fa: true,
          });
        }
      } else if (parsed.data.recoveryCode) {
        const codeHash = createHash('sha256')
          .update(parsed.data.recoveryCode.replace(/\s|-/g, '').toUpperCase())
          .digest('hex');
        if (!user.totpRecoveryCodes.includes(codeHash)) {
          return reply.code(401).send({
            error: 'Unauthorized',
            message: 'Invalid recovery code',
            requires2fa: true,
          });
        }
        // Single-use — strike it off the list.
        await app.prisma.user.update({
          where: { id: user.id },
          data: {
            totpRecoveryCodes: user.totpRecoveryCodes.filter((c) => c !== codeHash),
          },
        });
        await audit.record({
          action: 'TOTP_RECOVERY_USED',
          actorId: user.id,
          targetType: 'User',
          targetId: user.id,
          payload: { remaining: user.totpRecoveryCodes.length - 1 },
        });
      } else {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: '2FA code required',
          requires2fa: true,
        });
      }
    }

    const tokens = await issueTokens(user);
    return {
      // `token` retained for back-compat with older clients that may not
      // have been redeployed yet. New clients should read `accessToken`.
      token: tokens.accessToken,
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  });

  app.post('/register', authThrottle, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const exists = await app.prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (exists) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email already registered' });
    }
    const user = await app.prisma.user.create({
      data: {
        email: parsed.data.email,
        name: parsed.data.name,
        passwordHash: await hashPassword(parsed.data.password),
        role: 'CUSTOMER',
      },
    });
    const tokens = await issueTokens(user);
    return reply.code(201).send({
      token: tokens.accessToken,
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });

  /**
   * Exchange a refresh token for a new access+refresh pair. The presented
   * token is rotated — its row is revoked and a new row is created.
   *
   * Theft detection: if the presented token is *already revoked*, that
   * means somebody is re-playing an old stolen token. We respond by
   * revoking every active refresh token for this user, forcing all
   * sessions to re-login.
   */
  app.post('/refresh', authThrottle, async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
    }
    const hash = hashRefreshToken(parsed.data.refreshToken);
    const row = await app.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!row) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
    }
    if (row.revokedAt) {
      // Re-use of a rotated token — assume theft. Nuke the whole family.
      await app.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit.record({
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        actorId: row.userId,
        targetType: 'User',
        targetId: row.userId,
        payload: { tokenId: row.id },
      });
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Refresh token re-use detected; all sessions revoked.',
      });
    }
    if (row.expiresAt < new Date()) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Refresh token expired' });
    }
    const user = await app.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || !user.active) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Account disabled' });
    }

    // Rotate: revoke the presented token, issue a new pair.
    await app.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    const tokens = await issueTokens(user, { replacesId: row.id });
    return {
      token: tokens.accessToken,
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  });

  /**
   * Logout — revoke the presented refresh token so it can't be re-used.
   * Best-effort: silently 204s even if the token is unknown so we don't
   * leak validity.
   */
  app.post('/logout', async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(204).send();
    const hash = hashRefreshToken(parsed.data.refreshToken);
    await app.prisma.refreshToken.updateMany({
      where: { tokenHash: hash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = await app.prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { id: true, email: true, name: true, role: true, active: true, createdAt: true },
    });
    if (!user) return reply.code(404).send({ error: 'NotFound' });
    return user;
  });

  /**
   * Personnel default signature — used by the document routes to
   * optionally embed the caller's signature into generated PDFs. Caller
   * uploads the image via /uploads-api/signatures first, then PUTs the URL
   * here to save it as their default.
   */
  app.get(
    '/me/signature',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { defaultSignatureUrl: true, signatureSavedAt: true },
      });
      if (!user) return reply.code(404).send({ error: 'NotFound' });
      return {
        signatureUrl: user.defaultSignatureUrl,
        savedAt: user.signatureSavedAt,
      };
    },
  );

  app.put(
    '/me/signature',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = saveSignatureSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      const user = await app.prisma.user.update({
        where: { id: req.user.sub },
        data: {
          defaultSignatureUrl: parsed.data.signatureUrl,
          signatureSavedAt: new Date(),
        },
        select: { defaultSignatureUrl: true, signatureSavedAt: true },
      });
      await audit.record({
        action: 'USER_SIGNATURE_SAVE',
        actorId: req.user.sub,
        targetType: 'User',
        targetId: req.user.sub,
        payload: { signatureUrl: parsed.data.signatureUrl },
      });
      return {
        signatureUrl: user.defaultSignatureUrl,
        savedAt: user.signatureSavedAt,
      };
    },
  );

  app.delete(
    '/me/signature',
    { preHandler: [app.authenticate] },
    async (req) => {
      await app.prisma.user.update({
        where: { id: req.user.sub },
        data: { defaultSignatureUrl: null, signatureSavedAt: null },
      });
      await audit.record({
        action: 'USER_SIGNATURE_CLEAR',
        actorId: req.user.sub,
        targetType: 'User',
        targetId: req.user.sub,
        payload: {},
      });
      return { signatureUrl: null, savedAt: null };
    },
  );

  /**
   * Effective permission keys for the current user, computed as the union
   * across all their assigned roles. The web app uses this to hide actions
   * the user doesn't have permission for — but the source of truth for
   * authorization is always the server-side requirePermission middleware.
   */
  app.get(
    '/me/permissions',
    { preHandler: [app.authenticate] },
    async (req) => {
      const keys = await app.resolvePermissions(req.user.sub);
      const assignments = await app.prisma.userRoleAssignment.findMany({
        where: { userId: req.user.sub },
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
    },
  );

  /**
   * Read state for the notification bell.
   *
   *   GET  /auth/me/notifications/state — returns { lastSeenAt, unseen }
   *   POST /auth/me/notifications/seen  — advances lastSeenAt to now()
   *
   * The web app calls the POST when the user opens the bell dropdown, so
   * the badge resets to zero next time they look at it.
   */
  app.get(
    '/me/notifications/state',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const me = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { lastSeenNotificationAt: true },
      });
      if (!me) return reply.code(404).send({ error: 'NotFound' });
      // Count notifications created strictly after the cursor. When there's
      // no cursor yet (brand-new account) treat *everything* as unseen —
      // better than silently dropping the count to zero.
      const where = me.lastSeenNotificationAt
        ? { createdAt: { gt: me.lastSeenNotificationAt } }
        : {};
      const unseen = await app.prisma.notification.count({ where });
      return { lastSeenAt: me.lastSeenNotificationAt, unseen };
    },
  );

  app.post(
    '/me/notifications/seen',
    { preHandler: [app.authenticate] },
    async (req) => {
      const updated = await app.prisma.user.update({
        where: { id: req.user.sub },
        data: { lastSeenNotificationAt: new Date() },
        select: { lastSeenNotificationAt: true },
      });
      return { lastSeenAt: updated.lastSeenNotificationAt, unseen: 0 };
    },
  );

  // ─── 2FA (TOTP) ───────────────────────────────────────────────────
  //
  // Three-step flow:
  //   POST /me/2fa/setup    — generate a fresh secret + otpauth URI;
  //                           client renders a QR code
  //   POST /me/2fa/enable   — submit a TOTP code to prove the secret
  //                           was set up correctly; we persist + flip
  //                           totpEnabled, then return recovery codes
  //   POST /me/2fa/disable  — submit a current TOTP code to disable

  app.get(
    '/me/2fa/status',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const u = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { totpEnabled: true, totpRecoveryCodes: true },
      });
      if (!u) return reply.code(404).send({ error: 'NotFound' });
      return {
        enabled: u.totpEnabled,
        recoveryCodesRemaining: u.totpRecoveryCodes.length,
      };
    },
  );

  app.post(
    '/me/2fa/setup',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { email: true, totpEnabled: true },
      });
      if (!user) return reply.code(404).send({ error: 'NotFound' });
      if (user.totpEnabled) {
        return reply.code(409).send({
          error: 'AlreadyEnabled',
          message: '2FA is already enabled. Disable it first to re-set up.',
        });
      }
      const secret = authenticator.generateSecret();
      const otpauth = authenticator.keyuri(user.email, TOTP_ISSUER, secret);
      // Stash on the user row so enable/verify can read it without the
      // client having to round-trip the secret back. totpEnabled stays
      // false until /enable confirms.
      await app.prisma.user.update({
        where: { id: req.user.sub },
        data: { totpSecret: secret, totpEnabled: false },
      });
      return { secret, otpauth };
    },
  );

  const enableSchema = z.object({
    code: z.string().regex(/^\d{6}$/, '6-digit code required'),
  });

  app.post(
    '/me/2fa/enable',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = enableSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      const user = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { totpSecret: true, totpEnabled: true },
      });
      if (!user?.totpSecret) {
        return reply.code(400).send({
          error: 'NotSetup',
          message: 'Call /me/2fa/setup first to generate a secret.',
        });
      }
      const valid = authenticator.verify({ token: parsed.data.code, secret: user.totpSecret });
      if (!valid) {
        return reply.code(400).send({
          error: 'InvalidCode',
          message: 'Code did not match. Try the next one (codes rotate every 30s).',
        });
      }
      // Generate 10 single-use recovery codes — shown once, then we keep
      // only their hashes. Format: XXXX-XXXX (8 alphanumeric chars).
      const codes: string[] = [];
      const hashes: string[] = [];
      for (let i = 0; i < 10; i++) {
        const raw = randomBytes(5).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase();
        codes.push(raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw);
        hashes.push(createHash('sha256').update(raw).digest('hex'));
      }
      await app.prisma.user.update({
        where: { id: req.user.sub },
        data: { totpEnabled: true, totpRecoveryCodes: hashes },
      });
      await audit.record({
        action: 'TOTP_ENABLED',
        actorId: req.user.sub,
        targetType: 'User',
        targetId: req.user.sub,
        payload: {},
      });
      return { enabled: true, recoveryCodes: codes };
    },
  );

  const disableSchema = z.object({
    code: z.string().regex(/^\d{6}$/),
  });

  app.post(
    '/me/2fa/disable',
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const parsed = disableSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'ValidationError', issues: parsed.error.issues });
      }
      const user = await app.prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { totpSecret: true, totpEnabled: true },
      });
      if (!user?.totpEnabled || !user.totpSecret) {
        return reply.code(409).send({ error: 'NotEnabled', message: '2FA is not enabled.' });
      }
      const valid = authenticator.verify({ token: parsed.data.code, secret: user.totpSecret });
      if (!valid) {
        return reply.code(400).send({ error: 'InvalidCode', message: 'Wrong 2FA code.' });
      }
      await app.prisma.user.update({
        where: { id: req.user.sub },
        data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: [] },
      });
      await audit.record({
        action: 'TOTP_DISABLED',
        actorId: req.user.sub,
        targetType: 'User',
        targetId: req.user.sub,
        payload: {},
      });
      return { enabled: false };
    },
  );
}
