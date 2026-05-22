/**
 * Delegation service — security-critical path coverage.
 *
 * Scope: `create()` enforces two authority rules that the layered
 * refactor could silently break:
 *
 *   1. **Delegator authority** — the caller can only delegate from
 *      their own account UNLESS they hold `admin.users`. A regression
 *      that dropped this check would let any user forge a delegation
 *      chain "from" anyone else.
 *
 *   2. **Permission-not-held** — a delegator can only grant permission
 *      keys they currently hold. Empty `permissions[]` means "all of
 *      mine" (resolved at evaluation time, no check). A regression
 *      that skipped this check would let a low-privilege user create
 *      a delegation granting admin-level keys.
 *
 * The happy-path success case is intentionally not retested here —
 * it's exercised end-to-end by the routes. We only protect the gates.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `resolveUserPermissions` is imported from @loan/db inside the service.
// We mock the whole module so the service's call to it returns a known
// permission set without needing a Prisma client.
vi.mock("@loan/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@loan/db")>();
  return {
    ...actual,
    resolveUserPermissions: vi.fn(),
  };
});

import { resolveUserPermissions } from "@loan/db";
import { DelegationService } from "./delegations.service";

// The `resolveUserPermissions` mock is module-scoped, so call counts
// accumulate across tests. Reset between every test so each one can
// assert on its own call count cleanly.
beforeEach(() => {
  vi.mocked(resolveUserPermissions).mockReset();
});

function makeService() {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const repo = {
    create: vi.fn().mockResolvedValue({ id: "del-1" }),
  };
  // resolvePermissions for the *delegate* (callerPerms is supplied
  // separately by the controller in real code).
  const resolveDelegatePerms = vi.fn().mockResolvedValue(new Set<string>());
  const notifications = {
    dispatch: vi.fn().mockResolvedValue(undefined),
  };
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const service = new DelegationService(
    {} as never,
    repo as never,
    audit as never,
    resolveDelegatePerms,
    notifications as never,
    log as never,
  );
  return { service, audit, repo, resolveDelegatePerms, notifications };
}

const baseInput = {
  delegateId: "11111111-1111-1111-1111-111111111111",
  permissions: [],
  startsAt: "2026-01-01T00:00:00Z",
  endsAt: "2026-02-01T00:00:00Z",
};

describe("DelegationService.create — delegator authority", () => {
  it("refuses when caller targets a different delegator without admin.users", async () => {
    const { service, repo, audit } = makeService();
    const result = await service.create({
      callerId: "user-alice",
      callerPerms: new Set(["loans.read"]), // no admin.users
      input: {
        ...baseInput,
        delegatorId: "user-bob",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("ForbiddenDelegator");
    expect(result.message).toMatch(/only delegate from your own account/i);

    // No write, no audit. A regression that fired the audit first would
    // bloat the audit log with rejected attempts framed as ROLE actions.
    expect(repo.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("permits acting on someone else's behalf with admin.users", async () => {
    const { service, repo } = makeService();
    const result = await service.create({
      callerId: "user-alice",
      callerPerms: new Set(["admin.users"]),
      input: {
        ...baseInput,
        delegatorId: "user-bob",
      },
    });

    expect(result.ok).toBe(true);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ delegatorId: "user-bob" }),
    );
  });

  it("permits self-delegation regardless of permissions", async () => {
    const { service, repo } = makeService();
    const result = await service.create({
      callerId: "user-alice",
      callerPerms: new Set<string>(), // no perms at all
      input: { ...baseInput, delegatorId: "user-alice" },
    });

    expect(result.ok).toBe(true);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ delegatorId: "user-alice" }),
    );
  });
});

describe("DelegationService.create — permission-not-held guard", () => {
  it("refuses when explicit permissions include keys the delegator does not hold", async () => {
    // The delegator (== caller here) holds only `loans.read` — but is
    // trying to delegate `admin.users` + `loans.decide`. Both are
    // missing from their effective set, so the service should refuse.
    vi.mocked(resolveUserPermissions).mockResolvedValueOnce(
      new Set(["loans.read"]),
    );

    const { service, repo } = makeService();
    const result = await service.create({
      callerId: "user-alice",
      callerPerms: new Set(["loans.read"]),
      input: {
        ...baseInput,
        permissions: ["admin.users", "loans.decide"],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("MissingPermissions");
    expect(result.message).toContain("admin.users");
    expect(result.message).toContain("loans.decide");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("permits delegating a subset of the delegator's permissions", async () => {
    vi.mocked(resolveUserPermissions).mockResolvedValueOnce(
      new Set(["loans.read", "loans.decide", "admin.users"]),
    );

    const { service, repo } = makeService();
    const result = await service.create({
      callerId: "user-alice",
      callerPerms: new Set(["loans.read", "loans.decide", "admin.users"]),
      input: {
        ...baseInput,
        permissions: ["loans.decide"],
      },
    });

    expect(result.ok).toBe(true);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ["loans.decide"] }),
    );
  });

  it("skips the per-key check when permissions[] is empty (all-of-mine)", async () => {
    // Empty list means "delegate everything I currently hold" —
    // resolved at evaluation time, so no upfront check is needed.
    const { service, repo } = makeService();
    const result = await service.create({
      callerId: "user-alice",
      callerPerms: new Set<string>(),
      input: { ...baseInput, permissions: [] },
    });

    expect(result.ok).toBe(true);
    // Crucial: resolveUserPermissions must NOT be called when the list
    // is empty — calling it would be a wasted DB hit on the hot path.
    expect(vi.mocked(resolveUserPermissions)).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalled();
  });
});
