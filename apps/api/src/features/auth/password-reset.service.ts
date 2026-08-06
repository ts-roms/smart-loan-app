/**
 * Password reset — request a link, redeem it once.
 *
 * ## The two rules that shape everything here
 *
 * **Never reveal whether an address has an account.** `request()`
 * returns nothing at all: same response, same status, whether the
 * email matched a user, matched nobody, or matched someone whose
 * account is disabled. A reset form that answers "no such user" is a
 * free account-enumeration oracle, and for a lender that means
 * confirming who banks here.
 *
 * **A reset is a session event, not just a field update.** Anyone who
 * reset a password because they suspected someone else had it needs
 * the other party logged out — so redeeming a token revokes every
 * refresh token the user holds.
 *
 * ## Token handling
 *
 * Mirrors RefreshToken: 64 random bytes, only the SHA-256 stored, so a
 * database compromise yields no usable links. Single-use via `usedAt`
 * rather than deletion, which lets a second click be told apart from a
 * forged link.
 *
 * Requesting a reset invalidates any earlier outstanding token for
 * that user. Two live links would mean an old email still works after
 * someone asks for a fresh one — which is exactly the email a person
 * asks for when they think the first one was intercepted.
 */

import { createHash, randomBytes } from "node:crypto";

import { hashPassword } from "@loan/auth";
import type { NotificationRepository, PrismaClient } from "@loan/db";

/**
 * One hour. Long enough to walk to a desk and open a mail client,
 * short enough that a link sitting in an abandoned inbox stops
 * working. Stated in the email so the reader knows the clock exists.
 */
export const RESET_TTL_MS = 60 * 60 * 1000;
export const RESET_TTL_LABEL = "1 hour";

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export type ResetResult =
  { ok: true } | { ok: false; reason: "Invalid" | "Expired" | "AlreadyUsed" };

export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationRepository,
    private readonly webOrigin: string,
    private readonly companyName: string,
    private readonly log: Logger,
  ) {}

  /**
   * Start a reset. Returns void deliberately — see the class comment.
   *
   * Delivery failures are swallowed for the same reason: a mail
   * provider outage must not become a signal that the address was
   * real. It's logged instead.
   */
  async request(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true },
    });
    if (!user) return;

    // Any earlier link stops working the moment a new one is asked for.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const raw = randomBytes(64).toString("base64url");
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });

    const company = await this.prisma.systemConfig
      .findFirst({ select: { companyName: true } })
      .catch(() => null);

    try {
      await this.notifications.dispatch({
        event: "PASSWORD_RESET",
        channel: "EMAIL",
        recipient: user.email,
        data: {
          url: `${this.webOrigin}/reset-password/${raw}`,
          expiresIn: RESET_TTL_LABEL,
          companyName: company?.companyName ?? this.companyName,
        },
        refType: "User",
        refId: user.id,
      });
    } catch (err) {
      // Logged, never surfaced — an error here would tell the caller
      // the address exists.
      this.log.warn({ err, userId: user.id }, "password reset send failed");
    }
  }

  /**
   * Redeem a token and set the new password.
   *
   * The failure reasons are safe to show: by this point the caller
   * already holds a token, so "expired" or "already used" tells them
   * nothing about who owns it — and both need a different next step
   * from the user than a bare "invalid".
   */
  async reset(rawToken: string, newPassword: string): Promise<ResetResult> {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!row) return { ok: false, reason: "Invalid" };
    if (row.usedAt) return { ok: false, reason: "AlreadyUsed" };
    if (row.expiresAt <= new Date()) return { ok: false, reason: "Expired" };

    const passwordHash = await hashPassword(newPassword);

    // One transaction: a password changed without the sessions being
    // cut, or a token burned without the password landing, are both
    // worse than the whole thing failing.
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      }),
      this.prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { usedAt: new Date() },
      }),
      // Every existing session ends. Someone resetting because they
      // think another person has their password needs that person
      // signed out, not merely locked out of a future login.
      this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { ok: true };
  }

  /**
   * Is this token still redeemable? Lets the page say "this link has
   * expired" on arrival rather than after someone types a password
   * twice.
   */
  async check(rawToken: string): Promise<ResetResult> {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      select: { usedAt: true, expiresAt: true },
    });
    if (!row) return { ok: false, reason: "Invalid" };
    if (row.usedAt) return { ok: false, reason: "AlreadyUsed" };
    if (row.expiresAt <= new Date()) return { ok: false, reason: "Expired" };
    return { ok: true };
  }
}
