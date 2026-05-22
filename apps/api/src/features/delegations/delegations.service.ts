import {
  type AuditLogRepository,
  type DelegationRepository,
  type PrismaClient,
  resolveUserPermissions,
} from "@loan/db";

import type {
  CreateDelegationInput,
  ExtendDelegationInput,
  RevokeDelegationInput,
} from "./schemas.js";

/**
 * Delegation orchestration. The HTTP layer is intentionally a thin
 * adapter — the rules that matter (who can delegate on whose behalf,
 * which permission keys are allowed, whether an extend is valid) live
 * here so they're testable independent of Fastify and so we don't
 * accidentally duplicate them across `create`, `revoke`, `extend`.
 *
 * `resolvePermissions` is passed as a function so the service stays
 * Fastify-agnostic (the route decorates it onto the FastifyInstance).
 */

type DelegationRow = Awaited<ReturnType<DelegationRepository["create"]>>;

export type PermissionResolver = (userId: string) => Promise<Set<string>>;

export type CreateResult =
  | { ok: true; delegation: DelegationRow }
  | {
      ok: false;
      kind: "ForbiddenDelegator" | "MissingPermissions" | "RepoError";
      message: string;
    };

export type RevokeResult =
  | { ok: true; delegation: DelegationRow }
  | {
      ok: false;
      kind: "NotFound" | "Forbidden";
      message: string;
    };

export type ExtendResult =
  | { ok: true; delegation: DelegationRow }
  | {
      ok: false;
      kind: "NotFound" | "Forbidden" | "AlreadyRevoked" | "NotAfterCurrent";
      message: string;
    };

export class DelegationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: DelegationRepository,
    private readonly audit: AuditLogRepository,
    private readonly resolvePermissions: PermissionResolver,
  ) {}

  // ─── reads ────────────────────────────────────────────────────────

  userDirectory() {
    return this.prisma.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true },
    });
  }

  listForCaller(callerId: string) {
    return this.repo.listForUser(callerId);
  }

  listAll() {
    return this.repo.list();
  }

  listActiveFor(callerId: string) {
    return this.repo.listActiveFor(callerId);
  }

  // ─── writes ───────────────────────────────────────────────────────

  async create(args: {
    callerId: string;
    callerPerms: Set<string>;
    input: CreateDelegationInput;
  }): Promise<CreateResult> {
    const delegatorId = args.input.delegatorId ?? args.callerId;

    // Acting on someone else's behalf requires admin authority — the
    // signal that someone with the keys is doing the configuration, not
    // a regular user trying to forge a delegation chain.
    if (delegatorId !== args.callerId && !args.callerPerms.has("admin.users")) {
      return {
        ok: false,
        kind: "ForbiddenDelegator",
        message: "You can only delegate from your own account.",
      };
    }

    // Every explicit permission key must already be one the delegator
    // currently holds. Empty list = "all my permissions" (resolved at
    // evaluation time, so no check needed here).
    if (args.input.permissions.length > 0) {
      const delegatorPerms = await resolveUserPermissions(
        this.prisma,
        delegatorId,
      );
      const missing = args.input.permissions.filter(
        (p) => !delegatorPerms.has(p),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          kind: "MissingPermissions",
          message: `Cannot delegate permissions the delegator does not hold: ${missing.join(", ")}`,
        };
      }
    }

    try {
      const d = await this.repo.create({
        delegatorId,
        delegateId: args.input.delegateId,
        permissions: args.input.permissions,
        startsAt: new Date(args.input.startsAt),
        endsAt: new Date(args.input.endsAt),
        note: args.input.note,
      });
      await this.audit.record({
        action: "DELEGATION_CREATE",
        actorId: args.callerId,
        targetType: "Delegation",
        targetId: d.id,
        payload: {
          delegatorId,
          delegateId: args.input.delegateId,
          permissions: args.input.permissions,
          startsAt: args.input.startsAt,
          endsAt: args.input.endsAt,
        },
      });
      return { ok: true, delegation: d };
    } catch (err) {
      return {
        ok: false,
        kind: "RepoError",
        message: (err as Error).message,
      };
    }
  }

  async revoke(args: {
    id: string;
    callerId: string;
    callerPerms: Set<string>;
    input: RevokeDelegationInput;
  }): Promise<RevokeResult> {
    const d = await this.repo.findById(args.id);
    if (!d) {
      return { ok: false, kind: "NotFound", message: "Delegation not found." };
    }
    if (
      d.delegatorId !== args.callerId &&
      !args.callerPerms.has("admin.users")
    ) {
      return {
        ok: false,
        kind: "Forbidden",
        message: "Cannot revoke this delegation.",
      };
    }
    const updated = await this.repo.revoke(
      d.id,
      args.callerId,
      args.input.reason,
    );
    await this.audit.record({
      action: "DELEGATION_REVOKE",
      actorId: args.callerId,
      targetType: "Delegation",
      targetId: updated.id,
      payload: { reason: args.input.reason },
    });
    return { ok: true, delegation: updated };
  }

  async extend(args: {
    id: string;
    callerId: string;
    callerPerms: Set<string>;
    input: ExtendDelegationInput;
  }): Promise<ExtendResult> {
    const d = await this.repo.findById(args.id);
    if (!d) {
      return { ok: false, kind: "NotFound", message: "Delegation not found." };
    }
    if (
      d.delegatorId !== args.callerId &&
      !args.callerPerms.has("admin.users")
    ) {
      return {
        ok: false,
        kind: "Forbidden",
        message: "Cannot extend this delegation.",
      };
    }
    if (d.revokedAt) {
      return {
        ok: false,
        kind: "AlreadyRevoked",
        message: "Delegation has been revoked; create a new one.",
      };
    }
    const newEnd = new Date(args.input.endsAt);
    if (newEnd <= d.endsAt) {
      return {
        ok: false,
        kind: "NotAfterCurrent",
        message:
          "New end date must be after the current one. To shorten, revoke and recreate.",
      };
    }
    const updated = await this.repo.extend(d.id, newEnd);
    await this.audit.record({
      action: "DELEGATION_EXTEND",
      actorId: args.callerId,
      targetType: "Delegation",
      targetId: updated.id,
      payload: {
        previousEndsAt: d.endsAt.toISOString(),
        newEndsAt: newEnd.toISOString(),
      },
    });
    return { ok: true, delegation: updated };
  }
}
