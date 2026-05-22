import type { FastifyReply, FastifyRequest } from "fastify";

import type {
  AuthService,
  LoginResult,
  RegisterResult,
  RefreshResult,
} from "./auth.service";
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  saveSignatureSchema,
  totpCodeSchema,
} from "./schemas";

/**
 * HTTP adapter for the auth feature. Every method maps an HTTP
 * contract onto one AuthService call. The discriminated-union results
 * from the service map to specific HTTP codes here — never a throw,
 * so the wire shape is predictable on every error path.
 */
export class AuthController {
  constructor(private readonly service: AuthService) {}

  // ── Login + register + refresh + logout ────────────────────────────

  login = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.login(parsed.data);
    if (result.ok) return this.tokenResponse(result.tokens, result.user);
    return this.mapLoginError(result, reply);
  };

  register = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await this.service.register(parsed.data);
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
    const result = await this.service.refresh(parsed.data.refreshToken);
    if (result.ok) return this.tokenResponse(result.tokens, result.user);
    return this.mapRefreshError(result, reply);
  };

  logout = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(204).send();
    await this.service.logout(parsed.data.refreshToken);
    return reply.code(204).send();
  };

  // ── /me ────────────────────────────────────────────────────────────

  me = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await this.service.me(req.user.sub);
    if (!user) return reply.code(404).send({ error: "NotFound" });
    return user;
  };

  getSignature = async (req: FastifyRequest, reply: FastifyReply) => {
    const sig = await this.service.getSignature(req.user.sub);
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
    return this.service.setSignature(req.user.sub, parsed.data.signatureUrl);
  };

  clearSignature = async (req: FastifyRequest) => {
    return this.service.clearSignature(req.user.sub);
  };

  permissions = async (req: FastifyRequest) => {
    return this.service.permissions(req.user.sub);
  };

  notificationsState = async (req: FastifyRequest, reply: FastifyReply) => {
    const state = await this.service.notificationsState(req.user.sub);
    if (!state) return reply.code(404).send({ error: "NotFound" });
    return state;
  };

  markNotificationsSeen = async (req: FastifyRequest) => {
    return this.service.markNotificationsSeen(req.user.sub);
  };

  // ── 2FA ────────────────────────────────────────────────────────────

  totpStatus = async (req: FastifyRequest, reply: FastifyReply) => {
    const status = await this.service.totpStatus(req.user.sub);
    if (!status) return reply.code(404).send({ error: "NotFound" });
    return status;
  };

  totpSetup = async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await this.service.totpSetup(req.user.sub);
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
    const result = await this.service.totpEnable(req.user.sub, parsed.data);
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
    const result = await this.service.totpDisable(req.user.sub, parsed.data);
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
      return reply
        .code(401)
        .send({ error: "Unauthorized", message: "Invalid credentials" });
    }
    if (result.kind === "Invalid2faCode") {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Invalid 2FA code",
        requires2fa: true,
      });
    }
    if (result.kind === "InvalidRecoveryCode") {
      return reply.code(401).send({
        error: "Unauthorized",
        message: "Invalid recovery code",
        requires2fa: true,
      });
    }
    // Requires2fa — password was right, just need the second factor.
    return reply.code(401).send({
      error: "Unauthorized",
      message: "2FA code required",
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
