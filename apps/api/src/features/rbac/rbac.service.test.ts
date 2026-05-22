/**
 * RBAC service — security-critical path coverage.
 *
 * Scope: the **self-lockout guard** on `unassignRole`. The rule is
 * "you can't remove the ADMIN role from yourself" — strip your own
 * admin and your very next request loses `admin.users` and you're
 * locked out. Demoting a teammate-admin is fine; that's how
 * succession works.
 *
 * Everything else in RbacService is a pass-through (or an
 * audit-coupled write whose behavior is exercised by the repo's own
 * tests). This file only protects the rule that the layered refactor
 * could silently regress without a test.
 */

import { describe, expect, it, vi } from "vitest";

import { RbacService } from "./rbac.service";

// Minimal duck-typed deps. The service only touches the methods we
// stub, so the `as unknown as <Type>` cast is safe — TypeScript's
// nominal types would otherwise force us to mock every method on the
// real repository classes.
function makeService(opts?: {
  unassign?: ReturnType<typeof vi.fn>;
  /**
   * Count returned by `prisma.userRoleAssignment.count` when the
   * last-admin guard queries for "remaining active admins excluding
   * the target user". The default >0 means the guard passes; pass 0
   * to simulate "this is the last admin".
   */
  remainingAdmins?: number;
}) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const roles = {
    unassign: opts?.unassign ?? vi.fn().mockResolvedValue(undefined),
  };
  const userRoleAssignmentCount = vi
    .fn()
    .mockResolvedValue(opts?.remainingAdmins ?? 1);
  const prisma = {
    userRoleAssignment: { count: userRoleAssignmentCount },
  };
  const notifications = {
    dispatch: vi.fn().mockResolvedValue(undefined),
  };
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const service = new RbacService(
    prisma as never,
    {} as never, // permissions — not called
    roles as never,
    audit as never,
    notifications as never,
    log as never,
  );
  return {
    service,
    audit,
    roles,
    userRoleAssignmentCount,
    notifications,
  };
}

describe("RbacService.unassignRole — ADMIN self-lockout guard", () => {
  it("refuses to remove ADMIN from the caller's own user", async () => {
    const { service, audit, roles } = makeService();
    const result = await service.unassignRole({
      userId: "user-alice",
      roleKey: "ADMIN",
      actorId: "user-alice",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("SelfLockout");
    expect(result.message).toMatch(
      /cannot remove the ADMIN role from yourself/i,
    );

    // Crucially: the repo write and the audit row both must NOT happen.
    // A regression that logged the audit before checking the guard would
    // create a confusing trail (no role change, but an audit entry).
    expect(roles.unassign).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("allows removing ADMIN from a different user (succession)", async () => {
    const { service, audit, roles } = makeService();
    const result = await service.unassignRole({
      userId: "user-bob",
      roleKey: "ADMIN",
      actorId: "user-alice",
    });

    expect(result.ok).toBe(true);
    expect(roles.unassign).toHaveBeenCalledWith("user-bob", "ADMIN");
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_ROLE_UNASSIGN",
        actorId: "user-alice",
        targetType: "User",
        targetId: "user-bob",
        payload: { roleKey: "ADMIN" },
      }),
    );
  });

  it("allows removing a non-ADMIN role from the caller's own user", async () => {
    // The guard is keyed on the *role* being ADMIN, not on caller==target.
    // Demoting yourself from LOAN_OFFICER is fine — you don't lock yourself
    // out of admin.users (you didn't have it via that role).
    const { service, roles, userRoleAssignmentCount } = makeService();
    const result = await service.unassignRole({
      userId: "user-alice",
      roleKey: "LOAN_OFFICER",
      actorId: "user-alice",
    });

    expect(result.ok).toBe(true);
    expect(roles.unassign).toHaveBeenCalledWith("user-alice", "LOAN_OFFICER");
    // Non-ADMIN unassigns must not even trigger the count query — it's
    // wasted DB work and would skew the audit narrative.
    expect(userRoleAssignmentCount).not.toHaveBeenCalled();
  });
});

describe("RbacService.unassignRole — last-admin guard", () => {
  it("refuses when the target is the only remaining active admin", async () => {
    // Scenario: org has 2 admins, Alice + Bob. Alice removes Bob's
    // ADMIN. The self-lockout guard doesn't fire (Alice ≠ Bob), but
    // the last-admin guard catches it because Alice would later need
    // to demote/disable, and the org has no spare admin to rescue.
    //
    // Actually wait — Alice would still be admin after the removal.
    // The guard fires only when the target IS the last admin: e.g.
    // some hypothetical workflow where Alice has lost admin (perhaps
    // via a chained demotion) and Bob is the last one. Here we
    // simulate that condition by setting remainingAdmins=0.
    const { service, audit, roles } = makeService({ remainingAdmins: 0 });
    const result = await service.unassignRole({
      userId: "user-bob",
      roleKey: "ADMIN",
      actorId: "user-alice",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("LastAdmin");
    expect(result.message).toMatch(/last active admin/i);

    // No write, no audit. A regression that performed the unassign
    // before the count check would leave the org with zero admins.
    expect(roles.unassign).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("allows the removal when at least one other active admin remains", async () => {
    const { service, roles, audit } = makeService({ remainingAdmins: 1 });
    const result = await service.unassignRole({
      userId: "user-bob",
      roleKey: "ADMIN",
      actorId: "user-alice",
    });

    expect(result.ok).toBe(true);
    expect(roles.unassign).toHaveBeenCalledWith("user-bob", "ADMIN");
    expect(audit.record).toHaveBeenCalled();
  });

  it("skips the count query for non-ADMIN role removals", async () => {
    // The guard is ADMIN-specific. Removing LOAN_OFFICER from someone
    // — even if they're the last LOAN_OFFICER — is fine; nothing
    // about that locks the org out of administration.
    const { service, userRoleAssignmentCount } = makeService();
    const result = await service.unassignRole({
      userId: "user-bob",
      roleKey: "ACCOUNTANT",
      actorId: "user-alice",
    });

    expect(result.ok).toBe(true);
    expect(userRoleAssignmentCount).not.toHaveBeenCalled();
  });
});
