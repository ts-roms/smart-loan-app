import {
  type AuditLogRepository,
  type DelegationRepository,
  type NotificationRepository,
  type PrismaClient,
  resolveUserPermissions,
} from "@loan/db";
import type { FastifyBaseLogger } from "fastify";

import type {
  CreateDelegationInput,
  ExtendDelegationInput,
  RevokeDelegationInput,
} from "./schemas";

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

/**
 * Shape returned by `previewResolvedPermissions` — answers the
 * delegate's natural question "what does this delegation actually
 * grant me right now?". The interesting fields are:
 *
 *   - `resolvedPermissions`: the set the delegate would inherit if
 *     they exercised this delegation right now. The full set when
 *     `delegation.permissions[]` is empty ("all of mine"); the
 *     intersection of the explicit list with the delegator's current
 *     perms otherwise.
 *   - `droppedPermissions`: keys the delegation explicitly listed but
 *     the delegator no longer holds. Empty list ⇒ the delegation
 *     fully delivers what it promised. Non-empty list ⇒ something
 *     changed on the delegator's side since the delegation was
 *     created (a role demotion, a permission removal). The delegate
 *     sees one place where this is visible instead of having to
 *     re-derive it.
 *   - `isActiveNow`: convenience flag matching the resolver's
 *     definition (not revoked, startsAt ≤ now ≤ endsAt).
 */
export interface DelegationPreviewPayload {
  delegation: {
    id: string;
    delegatorId: string;
    delegateId: string;
    startsAt: Date;
    endsAt: Date;
    permissions: string[];
    revokedAt: Date | null;
  };
  resolvedPermissions: string[];
  droppedPermissions: string[];
  isActiveNow: boolean;
}

export type PreviewResult =
  | { ok: true; payload: DelegationPreviewPayload }
  | { ok: false; kind: "NotFound" }
  | { ok: false; kind: "Forbidden"; message: string };

export class DelegationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repo: DelegationRepository,
    private readonly audit: AuditLogRepository,
    private readonly resolvePermissions: PermissionResolver,
    private readonly notifications: NotificationRepository,
    private readonly log: FastifyBaseLogger,
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

  /**
   * Compute the resolved permission set this delegation grants right
   * now. Access is restricted to the delegator, the delegate, or a
   * caller with `admin.users` — otherwise a curious user could probe
   * other people's delegation contents.
   */
  async previewResolvedPermissions(args: {
    id: string;
    callerId: string;
    callerPerms: Set<string>;
  }): Promise<PreviewResult> {
    const d = await this.repo.findById(args.id);
    if (!d) return { ok: false, kind: "NotFound" };

    const isParty =
      d.delegatorId === args.callerId || d.delegateId === args.callerId;
    if (!isParty && !args.callerPerms.has("admin.users")) {
      return {
        ok: false,
        kind: "Forbidden",
        message:
          "Only the delegator, the delegate, or an admin can preview this delegation.",
      };
    }

    const delegatorPerms = await resolveUserPermissions(
      this.prisma,
      d.delegatorId,
    );

    let resolved: string[];
    let dropped: string[];
    if (d.permissions.length === 0) {
      // "All of mine" — resolved is just the delegator's current set,
      // and nothing can be "dropped" because nothing was explicitly
      // promised.
      resolved = [...delegatorPerms].sort();
      dropped = [];
    } else {
      const resolvedSet = new Set<string>();
      const droppedSet = new Set<string>();
      for (const p of d.permissions) {
        if (delegatorPerms.has(p)) resolvedSet.add(p);
        else droppedSet.add(p);
      }
      resolved = [...resolvedSet].sort();
      dropped = [...droppedSet].sort();
    }

    const now = new Date();
    const isActiveNow =
      d.revokedAt === null && d.startsAt <= now && now <= d.endsAt;

    return {
      ok: true,
      payload: {
        delegation: {
          id: d.id,
          delegatorId: d.delegatorId,
          delegateId: d.delegateId,
          startsAt: d.startsAt,
          endsAt: d.endsAt,
          permissions: d.permissions,
          revokedAt: d.revokedAt,
        },
        resolvedPermissions: resolved,
        droppedPermissions: dropped,
        isActiveNow,
      },
    };
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

    // Best-effort lifecycle notification to the delegate — the
    // revocation is already legally in effect (audit row + DB write
    // committed); a failed notification must NOT roll back the
    // primary action. Wrapped in catch + log so an outage on the
    // notification provider doesn't break revocation.
    await this.notifyRevoked(updated, args.input.reason).catch((err) =>
      this.log.warn(
        { err, delegationId: updated.id },
        "DELEGATION_REVOKED notification dispatch failed",
      ),
    );

    return { ok: true, delegation: updated };
  }

  /**
   * Notify the delegate that the delegation has been revoked.
   *
   * Channel reality check: the `Notification` model only links by
   * `customerId`, and `User` has no phone column — so for staff
   * lifecycle events we can deliver to **email only** today.
   * Skipping in-app + SMS isn't a missed feature; it's the truth of
   * the current schema, documented in the comments below so the
   * next contributor doesn't reinvent the design.
   *
   * If the delegate has no email on file the notification simply
   * isn't sent; the revocation itself is already in effect.
   */
  private async notifyRevoked(
    d: { id: string; delegatorId: string; delegateId: string },
    reason: string | null | undefined,
  ): Promise<void> {
    const [delegator, delegate] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: d.delegatorId },
        select: { name: true },
      }),
      this.prisma.user.findUnique({
        where: { id: d.delegateId },
        select: { name: true, email: true },
      }),
    ]);
    if (!delegate || !delegate.email) return;

    await this.notifications.dispatch({
      event: "DELEGATION_REVOKED",
      channel: "EMAIL",
      recipient: delegate.email,
      data: {
        delegatorName: delegator?.name ?? "your delegator",
        delegateName: delegate.name,
        // Templates can't conditionally include text; build the
        // suffix so the message reads "…was revoked." vs "…was
        // revoked. Reason: schedule conflict.".
        reasonSuffix:
          reason && reason.trim().length > 0
            ? `. Reason: ${reason.trim()}`
            : "",
      },
      refType: "Delegation",
      refId: d.id,
    });
    // SMS channel: User has no `phone` column. Skip until schema
    // grows one — out of scope for this change.
    // IN_APP channel: the Notification model links via customerId
    // (borrower-facing), not userId. Adding a staff-user inbox is
    // a separate design change that's out of scope here.
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
