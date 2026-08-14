import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  LoginResult,
  RegisterResult,
  RefreshResult,
} from "./auth.service";
import {
  completeProfileSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  saveSignatureSchema,
  totpCodeSchema,
} from "./schemas";

/**
 * HTTP adapter for the auth feature.
 *
 * **Phase 2 pattern**: stateless singleton. Each method reads the
 * per-request `AuthService` instance from `req.authServices.auth` —
 * that container is built by the preHandler chain in routes.ts from
 * the tenant-scoped Prisma client.
 *
 * The tenant slug is also surfaced on `req.tenantCtx.slug`. Login
 * and register need it for the JWT payload; the resolveTenant
 * preHandler (or, for unauthenticated requests, resolveTenantFromBody)
 * is responsible for populating it.
 */
export class AuthController {
  // ── Login + register + refresh + logout ────────────────────────────

  login = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.authServices!.auth.login(
      parsed.data,
      req.tenantCtx.slug,
    );

    /*
     * §56 — every login attempt is recorded, success or failure.
     *
     * Both halves matter and they go to different places. The
     * LoginAttempt row is written for EVERY attempt including the ones
     * against addresses that do not exist, which is the brute-force
     * case and the one AuditEvent structurally cannot hold (its
     * `actorId` is a NOT NULL foreign key to User). The AuditEvent is
     * written only on success, where there is a real user to attribute
     * it to.
     *
     * `failureReason` is the precise server-side kind, which is
     * deliberately MORE specific than what the caller is told —
     * `mapLoginError` keeps the response vague so the endpoint is not
     * an account-existence oracle. The precise reason belongs in the
     * security log, where only staff can read it.
     *
     * Best-effort, and awaited but never fatal: a login must not be
     * refused because the security log is unavailable. That is the
     * opposite of the call the money path makes — refusing a
     * disbursement is safe, but refusing every login turns a logging
     * outage into a total outage.
     */
    const attempts = req.authServices!.loginAttempts;
    if (result.ok) {
      await attempts.record({
        email: parsed.data.email,
        userId: result.user.id,
        success: true,
      });
      await req.authServices!.audit.record({
        action: "AUTH_LOGIN",
        actorId: result.user.id,
        targetType: "User",
        targetId: result.user.id,
      });
      return this.tokenResponse(result.tokens, result.user);
    }
    await attempts.record({
      email: parsed.data.email,
      success: false,
      failureReason: result.kind,
    });
    return this.mapLoginError(result, reply);
  };

  register = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.authServices!.auth.register(
      parsed.data,
      req.tenantCtx.slug,
    );
    if (result.ok) {
      return reply
        .code(201)
        .send(this.tokenResponse(result.tokens, result.user));
    }
    return this.mapRegisterError(result, reply);
  };

  refresh = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.authServices!.auth.refresh(
      parsed.data.refreshToken,
      req.tenantCtx.slug,
    );
    if (result.ok) return this.tokenResponse(result.tokens, result.user);
    return this.mapRefreshError(result, reply);
  };

  logout = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(204).send();
    const userId = await req.authServices!.auth.logout(
      parsed.data.refreshToken,
    );
    /*
     * §56 — audited only when a live token was actually revoked.
     *
     * A null userId means the token matched nothing: expired, already
     * revoked, or never valid. The endpoint still answers 204 (it must
     * not become an oracle), but there is no session that ended, so
     * there is nothing to record — and there is no actor id to hang an
     * AuditEvent on in any case.
     */
    if (userId) {
      await req.authServices!.audit.record({
        action: "AUTH_LOGOUT",
        actorId: userId,
        targetType: "User",
        targetId: userId,
      });
    }
    return reply.code(204).send();
  };

  // ── /me ────────────────────────────────────────────────────────────

  me = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await req.authServices!.auth.me(req.user.sub);
    if (!user) return reply.code(404).send({ error: "NotFound" });
    return user;
  };

  /**
   * Second half of self-registration — creates the borrower's Customer
   * record and links it to their login. Authenticated: the account
   * already exists at this point, it just can't do anything yet.
   */
  completeProfile = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = completeProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.authServices!.auth.completeProfile(
      req.user.sub,
      parsed.data,
    );
    if (result.ok) return reply.code(201).send({ user: result.user });

    switch (result.kind) {
      case "NotFound":
        return reply.code(404).send({ error: "NotFound" });
      case "NotACustomer":
        // 403, not 400: the request is well-formed, the caller just
        // isn't a borrower. Staff records are managed through /rbac.
        return reply.code(403).send({
          error: "NotACustomer",
          message: "Only borrower accounts have a profile to complete.",
        });
      case "AlreadyLinked":
        return reply.code(409).send({
          error: "AlreadyLinked",
          message:
            "This account already has a borrower profile. Edit it from your portal profile instead.",
        });
    }
  };

  getSignature = async (req: FastifyRequest, reply: FastifyReply) => {
    const sig = await req.authServices!.auth.getSignature(req.user.sub);
    if (!sig) return reply.code(404).send({ error: "NotFound" });
    return sig;
  };

  setSignature = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = saveSignatureSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.authServices!.auth.setSignature(
      req.user.sub,
      parsed.data.signatureUrl,
    );
  };

  clearSignature = async (req: FastifyRequest) => {
    return req.authServices!.auth.clearSignature(req.user.sub);
  };

  permissions = async (req: FastifyRequest) => {
    return req.authServices!.auth.permissions(req.user.sub);
  };

  notificationsState = async (req: FastifyRequest, reply: FastifyReply) => {
    const state = await req.authServices!.auth.notificationsState(req.user.sub);
    if (!state) return reply.code(404).send({ error: "NotFound" });
    return state;
  };

  markNotificationsSeen = async (req: FastifyRequest) => {
    return req.authServices!.auth.markNotificationsSeen(req.user.sub);
  };

  // ── 2FA ────────────────────────────────────────────────────────────

  totpStatus = async (req: FastifyRequest, reply: FastifyReply) => {
    const status = await req.authServices!.auth.totpStatus(req.user.sub);
    if (!status) return reply.code(404).send({ error: "NotFound" });
    return status;
  };

  totpSetup = async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await req.authServices!.auth.totpSetup(req.user.sub);
    if (result.ok) return { secret: result.secret, otpauth: result.otpauth };
    if (result.kind === "NotFound") {
      return reply.code(404).send({ error: "NotFound" });
    }
    return reply.code(409).send({
      error: "AlreadyEnabled",
      message: "2FA is already enabled. Disable it first to re-set up.",
    });
  };

  totpEnable = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = totpCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.authServices!.auth.totpEnable(
      req.user.sub,
      parsed.data,
    );
    if (result.ok) {
      return { enabled: true, recoveryCodes: result.recoveryCodes };
    }
    if (result.kind === "NotSetup") {
      return reply.code(400).send({
        error: "NotSetup",
        message: "Call /me/2fa/setup first to generate a secret.",
      });
    }
    return reply.code(400).send({
      error: "InvalidCode",
      message: "Code did not match. Try the next one (codes rotate every 30s).",
    });
  };

  totpDisable = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = totpCodeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.authServices!.auth.totpDisable(
      req.user.sub,
      parsed.data,
    );
    if (result.ok) return { enabled: false };
    if (result.kind === "NotEnabled") {
      return reply
        .code(409)
        .send({ error: "NotEnabled", message: "2FA is not enabled." });
    }
    return reply
      .code(400)
      .send({ error: "InvalidCode", message: "Wrong 2FA code." });
  };

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Build the login/register/refresh response. `token` is retained for
   * back-compat with older clients that may not have been redeployed
   * yet — new clients should read `accessToken`.
   */
  private tokenResponse(
    tokens: {
      accessToken: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
    },
    user: { id: string; email: string; name: string; role: string },
  ) {
    return {
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      user,
    };
  }

  private mapLoginError(
    result: LoginResult & { ok: false },
    reply: FastifyReply,
  ) {
    if (result.kind === "InvalidCredentials") {
      // One message for a wrong email and a wrong password, on
      // purpose: distinguishing them tells an attacker which addresses
      // are registered. The wording just stops sounding like a log
      // line.
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Invalid email or password",
      });
    }
    if (result.kind === "Invalid2faCode") {
      return reply.code(401).send({
        error: "Unauthorized",
        message:
          "That code isn't right. Check your authenticator app and try again.",
        requires2fa: true,
      });
    }
    if (result.kind === "InvalidRecoveryCode") {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "That recovery code isn't right, or it has already been used.",
        requires2fa: true,
      });
    }
    // Requires2fa — password was right, just need the second factor.
    return reply.code(401).send({
      error: "Unauthorized",
      message: "Enter the code from your authenticator app.",
      requires2fa: true,
    });
  }

  private mapRegisterError(
    result: RegisterResult & { ok: false },
    reply: FastifyReply,
  ) {
    return reply.code(409).send({
      error: "Conflict",
      message:
        result.kind === "EmailExists" ? "Email already registered" : "Conflict",
    });
  }

  private mapRefreshError(
    result: RefreshResult & { ok: false },
    reply: FastifyReply,
  ) {
    if (result.kind === "ReuseDetected") {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Refresh token re-use detected; all sessions revoked.",
      });
    }
    // The early return above narrows `kind` to the remaining three.
    const messages: Record<
      "InvalidToken" | "Expired" | "AccountDisabled",
      string
    > = {
      InvalidToken: "Invalid refresh token",
      Expired: "Refresh token expired",
      AccountDisabled: "Account disabled",
    };
    return reply
      .code(401)
      .send({ error: "Unauthorized", message: messages[result.kind] });
  }
}
