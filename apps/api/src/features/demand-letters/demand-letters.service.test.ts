/**
 * Demand-letter service — security-critical path coverage.
 *
 * Scope: FRD §3.6.5 escalation matrix on `approve()`. Two distinct
 * gates that the layered refactor could silently break:
 *
 *   1. **Stage-gated permission** — attorney stages require
 *      `collections.dl_approve_legal`; earlier stages require
 *      `collections.dl_approve_company`. The route's preHandler
 *      accepts either, then the service narrows to the right one
 *      based on the letter's stage. A regression here would let a
 *      company-level approver sign off on attorney letters.
 *
 *   2. **Segregation of duties** — the drafter can never self-approve
 *      (even if they have both permission keys). A regression would
 *      collapse the two-person-rule that FRD §3.6.5 codifies.
 *
 * Also covers the NotFound path so the controller's 404 mapping has
 * test coverage.
 */

import { describe, expect, it, vi } from "vitest";

import { DemandLetterService } from "./demand-letters.service";

function makeService(opts?: { letter?: unknown }) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const repo = {
    findById: vi.fn().mockResolvedValue(opts?.letter ?? null),
    approve: vi.fn().mockResolvedValue({
      id: "letter-1",
      stage: "FIRST",
      status: "APPROVED",
    }),
  };
  const loans = {};
  const notifications = {};
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const service = new DemandLetterService(
    {} as never,
    repo as never,
    loans as never,
    notifications as never,
    audit as never,
    log as never,
  );
  return { service, audit, repo };
}

describe("DemandLetterService.approve — NotFound", () => {
  it("returns NotFound when the letter id doesn't exist", async () => {
    const { service, audit, repo } = makeService({ letter: null });
    const result = await service.approve({
      id: "missing-id",
      input: {},
      actorId: "user-alice",
      callerPerms: new Set(["collections.dl_approve_company"]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
    expect(repo.approve).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("DemandLetterService.approve — stage-gated permission (FRD §3.6.5)", () => {
  it("ATTORNEY_FIRST requires dl_approve_legal, refuses company-only", async () => {
    const { service, repo, audit } = makeService({
      letter: {
        id: "letter-1",
        stage: "ATTORNEY_FIRST",
        draftedById: "drafter-1",
      },
    });

    const result = await service.approve({
      id: "letter-1",
      input: {},
      actorId: "user-alice",
      callerPerms: new Set(["collections.dl_approve_company"]), // wrong key
    });

    expect(result.ok).toBe(false);
    // Narrow to the message-bearing variant (the NotFound branch in
    // ApproveResult has no `message` field).
    if (result.ok || result.kind === "NotFound") {
      throw new Error("expected ForbiddenStagePerm");
    }
    expect(result.kind).toBe("ForbiddenStagePerm");
    expect(result.message).toContain("ATTORNEY_FIRST");
    expect(result.message).toContain("collections.dl_approve_legal");
    expect(result.message).toContain("FRD §3.6.5");
    expect(repo.approve).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("ATTORNEY_FINAL accepts dl_approve_legal", async () => {
    const { service, repo } = makeService({
      letter: {
        id: "letter-1",
        stage: "ATTORNEY_FINAL",
        draftedById: "drafter-1",
      },
    });

    const result = await service.approve({
      id: "letter-1",
      input: {},
      actorId: "user-alice", // ≠ drafter
      callerPerms: new Set(["collections.dl_approve_legal"]),
    });

    expect(result.ok).toBe(true);
    expect(repo.approve).toHaveBeenCalled();
  });

  it("FIRST stage requires dl_approve_company, refuses legal-only", async () => {
    const { service, repo } = makeService({
      letter: { id: "letter-1", stage: "FIRST", draftedById: "drafter-1" },
    });

    const result = await service.approve({
      id: "letter-1",
      input: {},
      actorId: "user-alice",
      callerPerms: new Set(["collections.dl_approve_legal"]), // wrong key
    });

    expect(result.ok).toBe(false);
    // Narrow to the message-bearing variant (the NotFound branch in
    // ApproveResult has no `message` field).
    if (result.ok || result.kind === "NotFound") {
      throw new Error("expected ForbiddenStagePerm");
    }
    expect(result.kind).toBe("ForbiddenStagePerm");
    expect(result.message).toContain("collections.dl_approve_company");
    expect(repo.approve).not.toHaveBeenCalled();
  });

  it("FINAL stage accepts dl_approve_company", async () => {
    const { service, repo } = makeService({
      letter: { id: "letter-1", stage: "FINAL", draftedById: "drafter-1" },
    });

    const result = await service.approve({
      id: "letter-1",
      input: {},
      actorId: "user-alice",
      callerPerms: new Set(["collections.dl_approve_company"]),
    });

    expect(result.ok).toBe(true);
    expect(repo.approve).toHaveBeenCalled();
  });
});

describe("DemandLetterService.approve — segregation of duties", () => {
  it("refuses when the caller is the drafter, even with the right permission", async () => {
    const { service, repo, audit } = makeService({
      letter: { id: "letter-1", stage: "FIRST", draftedById: "user-alice" },
    });

    const result = await service.approve({
      id: "letter-1",
      input: {},
      actorId: "user-alice", // same as drafter
      callerPerms: new Set(["collections.dl_approve_company"]),
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.kind === "NotFound") {
      throw new Error("expected ForbiddenSelfApprove");
    }
    expect(result.kind).toBe("ForbiddenSelfApprove");
    expect(result.message).toMatch(/drafter cannot self-approve/i);
    expect(repo.approve).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("permits approval when caller ≠ drafter and permission matches stage", async () => {
    const { service, repo, audit } = makeService({
      letter: { id: "letter-1", stage: "FIRST", draftedById: "drafter-1" },
    });

    const result = await service.approve({
      id: "letter-1",
      input: { note: "looks good" },
      actorId: "user-alice", // different person
      callerPerms: new Set(["collections.dl_approve_company"]),
    });

    expect(result.ok).toBe(true);
    expect(repo.approve).toHaveBeenCalledWith("letter-1", {
      approvedById: "user-alice",
      note: "looks good",
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DEMAND_LETTER_APPROVE",
        actorId: "user-alice",
        targetType: "DemandLetter",
      }),
    );
  });
});
