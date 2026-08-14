/**
 * Login attempts — the security log for credential presentation.
 *
 * Split from `AuditEvent` because `AuditEvent.actorId` is a NOT NULL
 * foreign key to User, and the failed login that matters most — one
 * against an address that does not exist — has no user row to point at.
 * A brute-force sweep across invented addresses is exactly the event
 * §56 wants recorded and exactly the event `AuditEvent` cannot hold.
 *
 * Successes are recorded alongside failures: "forty failures from one
 * IP, then a success" is the sentence worth being able to write, and it
 * cannot be written if only failures are stored.
 *
 * Like the audit log, this is best-effort — a login must not be refused
 * because the security log is unavailable. That is the opposite of the
 * call the money path makes, and deliberately so: refusing a
 * disbursement is safe, but refusing every login turns a logging outage
 * into a total outage, and the failure is self-announcing anyway (the
 * user retries, loudly). The write is also outside the caller's
 * transaction, so a failure here cannot roll back a token issue.
 */

import type { LoginAttempt, PrismaClient } from "@prisma/client";

import type { AuditLogger, AuditRequestContext } from "./audit-log.repository";

/** `User-Agent` is attacker-controlled and unbounded; cap what we store. */
const USER_AGENT_MAX = 512;

export interface LoginAttemptInput {
  /** The address as typed. Lowercased on write. */
  email: string;
  /** Resolved user id, when the address matched an account. */
  userId?: string | null;
  success: boolean;
  /**
   * Server-side reason. Note this is intentionally more specific than
   * what the caller is told — the HTTP response stays vague so the
   * endpoint is not an account-existence oracle.
   */
  failureReason?: string | null;
  /** Per-call override; defaults to the repo's request context. */
  context?: AuditRequestContext | null;
}

export class LoginAttemptRepository {
  private readonly defaultContext: AuditRequestContext | null;
  private readonly logger: AuditLogger;

  constructor(
    private readonly prisma: PrismaClient,
    options?: {
      context?: AuditRequestContext | null;
      logger?: AuditLogger;
    },
  ) {
    this.defaultContext = options?.context ?? null;
    this.logger = options?.logger ?? {
      error: (obj, msg) => console.error(msg, obj),
    };
  }

  async record(input: LoginAttemptInput): Promise<LoginAttempt | null> {
    const ctx =
      input.context === undefined ? this.defaultContext : input.context;
    try {
      return await this.prisma.loginAttempt.create({
        data: {
          email: input.email.trim().toLowerCase(),
          userId: input.userId ?? undefined,
          success: input.success,
          failureReason: input.failureReason ?? undefined,
          tenantId: ctx?.tenantId ?? undefined,
          ipAddress: ctx?.ipAddress ?? undefined,
          userAgent: ctx?.userAgent?.slice(0, USER_AGENT_MAX) ?? undefined,
          requestId: ctx?.requestId ?? undefined,
        },
      });
    } catch (err) {
      this.logger.error(
        {
          err,
          success: input.success,
          requestId: ctx?.requestId ?? undefined,
          // Deliberately NOT logging the email on failure: this line
          // goes to the general log stream, and a failed-login log
          // should not become a second, less-protected copy of who is
          // trying to sign in.
        },
        "[login-attempt] failed to record attempt",
      );
      return null;
    }
  }

  /**
   * Recent failures for an address, newest first. The lockout /
   * alerting query — served by `LoginAttempt_email_createdAt_idx`.
   */
  recentFailuresForEmail(
    email: string,
    since: Date,
    take = 50,
  ): Promise<LoginAttempt[]> {
    return this.prisma.loginAttempt.findMany({
      where: {
        email: email.trim().toLowerCase(),
        success: false,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  /**
   * Recent failures from an origin, newest first. Catches the spray
   * across many addresses that a per-email view cannot see — served by
   * `LoginAttempt_ipAddress_createdAt_idx`.
   */
  recentFailuresForIp(
    ipAddress: string,
    since: Date,
    take = 50,
  ): Promise<LoginAttempt[]> {
    return this.prisma.loginAttempt.findMany({
      where: { ipAddress, success: false, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take,
    });
  }

  list(filter?: {
    email?: string;
    ipAddress?: string;
    success?: boolean;
    from?: Date;
    to?: Date;
    take?: number;
  }): Promise<LoginAttempt[]> {
    return this.prisma.loginAttempt.findMany({
      where: {
        email: filter?.email?.trim().toLowerCase(),
        ipAddress: filter?.ipAddress,
        success: filter?.success,
        createdAt: { gte: filter?.from, lte: filter?.to },
      },
      orderBy: { createdAt: "desc" },
      take: filter?.take ?? 200,
    });
  }
}
