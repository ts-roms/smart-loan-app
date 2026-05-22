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

import { RbacService } from "./rbac.service.js";

// Minimal duck-typed deps. The service only touches the methods we
// stub, so the `as unknown as <Type>` cast is safe — TypeScript's
// nominal types would otherwise force us to mock every method on the
// real repository classes.
function makeService(opts?: { unassign?: ReturnType<typeof vi.fn> }) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const roles = {
    unassign: opts?.unassign ?? vi.fn().mockResolvedValue(undefined),
  };
  const service = new RbacService(
    {} as never, // prisma — not called in unassignRole
    {} as never, // permissions — not called
    roles as never,
    audit as never,
  );
  return { service, audit, roles };
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
    const { service, roles } = makeService();
    const result = await service.unassignRole({
      userId: "user-alice",
      roleKey: "LOAN_OFFICER",
      actorId: "user-alice",
    });

    expect(result.ok).toBe(true);
    expect(roles.unassign).toHaveBeenCalledWith("user-alice", "LOAN_OFFICER");
  });
});
