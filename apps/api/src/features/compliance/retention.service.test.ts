/**
 * Retention service — gating tests.
 *
 * Scope:
 *   1. `runPurge` honors per-table opt-out (days=0 ⇒ skip).
 *   2. `runPurge` computes the cutoff from the policy.
 *   3. `runPurge` writes a single audit row summarizing the result.
 *   4. `getPolicy` raises the AMLA-floor flag when audit < 1825.
 *   5. `updatePolicy` audits the change with the chosen values.
 */

import { describe, expect, it, vi } from "vitest";

import { AMLA_AUDIT_FLOOR_DAYS, RetentionService } from "./retention.service";

type AuditCall = {
  action: string;
  actorId: string;
  targetType?: string;
  payload?: unknown;
};

function makePrisma(opts: {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
}) {
  // upsert returns the same row regardless of update/create — we're
  // only testing what runPurge does with the returned policy values.
  const cfg = {
    auditRetentionDays: opts.auditRetentionDays,
    notificationRetentionDays: opts.notificationRetentionDays,
    jobRunRetentionDays: opts.jobRunRetentionDays,
  };
  return {
    systemConfig: {
      upsert: vi.fn(async () => cfg),
    },
    auditEvent: {
      deleteMany: vi.fn(
        async (_arg: { where: { createdAt: { lt: Date } } }) => ({ count: 42 }),
      ),
    },
    notification: {
      deleteMany: vi.fn(
        async (_arg: { where: { createdAt: { lt: Date } } }) => ({ count: 7 }),
      ),
    },
    jobRun: {
      deleteMany: vi.fn(
        async (_arg: { where: { startedAt: { lt: Date } } }) => ({
          count: 100,
        }),
      ),
    },
  };
}

function makeAudit() {
  return {
    record: vi.fn(async (_input: AuditCall) => ({ id: "audit-1" })),
  };
}

describe("RetentionService.runPurge", () => {
  it("deletes from every table when all knobs are positive", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 365,
      jobRunRetentionDays: 90,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const r = await svc.runPurge({ actorId: "system" });
    expect(r.deleted).toEqual({
      auditEvents: 42,
      notifications: 7,
      jobRuns: 100,
    });
    // Cutoffs are present for all three tables.
    expect(r.cutoffs.audit).not.toBeNull();
    expect(r.cutoffs.notification).not.toBeNull();
    expect(r.cutoffs.jobRun).not.toBeNull();
    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.jobRun.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("skips tables whose retention is 0 (opt-out)", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 0, // opt-out
      notificationRetentionDays: 365,
      jobRunRetentionDays: 0, // opt-out
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const r = await svc.runPurge({ actorId: "system" });
    expect(prisma.auditEvent.deleteMany).not.toHaveBeenCalled();
    expect(prisma.jobRun.deleteMany).not.toHaveBeenCalled();
    expect(prisma.notification.deleteMany).toHaveBeenCalledTimes(1);
    expect(r.cutoffs.audit).toBeNull();
    expect(r.cutoffs.jobRun).toBeNull();
    expect(r.cutoffs.notification).not.toBeNull();
    expect(r.deleted.auditEvents).toBe(0);
    expect(r.deleted.jobRuns).toBe(0);
  });

  it("computes audit cutoff from the policy (days back)", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 30,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const before = Date.now();
    await svc.runPurge({ actorId: "system" });
    const after = Date.now();

    const call = prisma.auditEvent.deleteMany.mock.calls[0]![0];
    const cutoff = call.where.createdAt.lt.getTime();
    // cutoff = startedAt - 30 days. Allow a ~1s window for the
    // before/after timestamps to bracket it.
    const expectedMin = before - 30 * 86_400_000 - 1000;
    const expectedMax = after - 30 * 86_400_000 + 1000;
    expect(cutoff).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff).toBeLessThanOrEqual(expectedMax);
  });

  it("writes a single audit row summarizing the run", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 365,
      jobRunRetentionDays: 90,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    await svc.runPurge({ actorId: "system" });
    expect(audit.record).toHaveBeenCalledTimes(1);
    const call = audit.record.mock.calls[0]![0] as unknown as {
      action: string;
      actorId: string;
      payload: { deleted: { auditEvents: number } };
    };
    expect(call.action).toBe("RETENTION_PURGE");
    expect(call.actorId).toBe("system");
    expect(call.payload.deleted.auditEvents).toBe(42);
  });
});

describe("RetentionService.getPolicy", () => {
  it("flags below-AMLA-floor when audit < 1825 and >0", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 365, // 1 year — below floor
      notificationRetentionDays: 90,
      jobRunRetentionDays: 30,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const p = await svc.getPolicy();
    expect(p.auditBelowAmlaFloor).toBe(true);
  });

  it("does NOT flag the AMLA floor when audit is 0 (opt-out is a deliberate choice)", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 0,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const p = await svc.getPolicy();
    expect(p.auditBelowAmlaFloor).toBe(false);
  });

  it("does NOT flag the AMLA floor when audit >= 1825", async () => {
    const prisma = makePrisma({
      auditRetentionDays: AMLA_AUDIT_FLOOR_DAYS,
      notificationRetentionDays: 365,
      jobRunRetentionDays: 90,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const p = await svc.getPolicy();
    expect(p.auditBelowAmlaFloor).toBe(false);
  });
});

describe("RetentionService.updatePolicy", () => {
  it("audits the change with the chosen values", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 730,
      notificationRetentionDays: 180,
      jobRunRetentionDays: 30,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    await svc.updatePolicy({
      input: {
        auditRetentionDays: 730,
        notificationRetentionDays: 180,
        jobRunRetentionDays: 30,
      },
      actorId: "admin-1",
    });
    const call = audit.record.mock.calls[0]![0] as unknown as {
      action: string;
      payload: { auditRetentionDays: number };
    };
    expect(call.action).toBe("RETENTION_POLICY_UPDATE");
    expect(call.payload.auditRetentionDays).toBe(730);
  });
});
