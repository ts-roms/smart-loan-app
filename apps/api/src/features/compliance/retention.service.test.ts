/**
 * Retention service — gating tests.
 *
 * Scope:
 *   1. `runPurge` honors per-table opt-out (days=0 ⇒ skip).
 *   2. `runPurge` computes the cutoff from the policy.
 *   3. `runPurge` writes a single audit row summarizing the result.
 *   4. `getPolicy` raises the AMLA-floor flag when audit < 1825.
 *   5. `updatePolicy` audits the change with the chosen values, and
 *      REFUSES a below-floor audit window.
 *   6. The §56 carve-out: financial, security, privacy and as-yet
 *      unknown audit actions survive a purge whose date cutoff reaches
 *      them, and so does anything done under impersonation.
 */

import { describe, expect, it, vi } from "vitest";

import { OPERATIONAL_AUDIT_ACTIONS } from "./audit-retention";
import { AMLA_AUDIT_FLOOR_DAYS, RetentionService } from "./retention.service";

type AuditCall = {
  action: string;
  actorId: string;
  targetType?: string;
  payload?: unknown;
};

/** An audit row as the carve-out sees it. */
interface AuditRow {
  action: string;
  createdAt: Date;
  impersonatedById: string | null;
}

interface AuditDeleteWhere {
  createdAt: { lt: Date };
  action?: { in: string[] };
  impersonatedById?: null;
}

function makePrisma(opts: {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
  /** When supplied, `auditEvent.deleteMany` really filters these. */
  auditRows?: AuditRow[];
}) {
  // upsert returns the same row regardless of update/create — we're
  // only testing what runPurge does with the returned policy values.
  const cfg = {
    auditRetentionDays: opts.auditRetentionDays,
    notificationRetentionDays: opts.notificationRetentionDays,
    jobRunRetentionDays: opts.jobRunRetentionDays,
  };
  const auditRows = opts.auditRows;
  return {
    systemConfig: {
      upsert: vi.fn(async () => cfg),
    },
    auditEvent: {
      // With no seeded rows this keeps the historical fixed count, so
      // the pre-existing tests keep asserting what they always did.
      // With seeded rows it APPLIES the where clause, which is how the
      // carve-out gets proved rather than assumed: the survivors are
      // whatever the real filter would have left behind.
      deleteMany: vi.fn(async (arg: { where: AuditDeleteWhere }) => {
        if (!auditRows) return { count: 42 };
        const { createdAt, action, impersonatedById } = arg.where;
        const doomed = auditRows.filter(
          (r) =>
            r.createdAt < createdAt.lt &&
            (action === undefined || action.in.includes(r.action)) &&
            (impersonatedById === undefined || r.impersonatedById === null),
        );
        for (const row of doomed) auditRows.splice(auditRows.indexOf(row), 1);
        return { count: doomed.length };
      }),
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
      auditRetentionDays: 2000,
      notificationRetentionDays: 180,
      jobRunRetentionDays: 30,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const result = await svc.updatePolicy({
      input: {
        auditRetentionDays: 2000,
        notificationRetentionDays: 180,
        jobRunRetentionDays: 30,
      },
      actorId: "admin-1",
    });
    expect(result.ok).toBe(true);
    const call = audit.record.mock.calls[0]![0] as unknown as {
      action: string;
      payload: { auditRetentionDays: number };
    };
    expect(call.action).toBe("RETENTION_POLICY_UPDATE");
    expect(call.payload.auditRetentionDays).toBe(2000);
  });

  it("REFUSES an audit window below the AMLA floor, and writes nothing", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 180,
      jobRunRetentionDays: 30,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const result = await svc.updatePolicy({
      input: {
        auditRetentionDays: 365, // one year — below the 5-year floor
        notificationRetentionDays: 180,
        jobRunRetentionDays: 30,
      },
      actorId: "admin-1",
    });

    expect(result.ok).toBe(false);
    expect((result as { kind: string }).kind).toBe("BelowRegulatoryFloor");
    expect((result as { floorDays: number }).floorDays).toBe(
      AMLA_AUDIT_FLOOR_DAYS,
    );
    expect((result as { requestedDays: number }).requestedDays).toBe(365);
    // The refusal is real: no write, no audit row for a change that
    // never happened. This used to be a cosmetic flag on a value the
    // service accepted regardless.
    expect(prisma.systemConfig.upsert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("still accepts 0 — 'never purge' is above the floor, not below it", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 0,
      notificationRetentionDays: 180,
      jobRunRetentionDays: 30,
    });
    const audit = makeAudit();
    const svc = new RetentionService(prisma as never, audit as never);

    const result = await svc.updatePolicy({
      input: {
        auditRetentionDays: 0,
        notificationRetentionDays: 180,
        jobRunRetentionDays: 30,
      },
      actorId: "admin-1",
    });
    expect(result.ok).toBe(true);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

/**
 * §56 vs §71. The purge used to run one unqualified
 * `deleteMany({ createdAt: { lt: cutoff } })`, so a loan approval and a
 * "someone ran a report" row expired on the same clock. These cover the
 * carve-out that keeps the clock away from rows with a regulatory floor.
 */
describe("RetentionService.runPurge — audit carve-out", () => {
  const ancient = new Date("2000-01-01");

  it("keeps regulated rows a bare cutoff would have deleted", async () => {
    const auditRows: AuditRow[] = [
      // Noise — genuinely disposable.
      {
        action: "REPORT_GENERATED",
        createdAt: ancient,
        impersonatedById: null,
      },
      { action: "RBAC_SYNC", createdAt: ancient, impersonatedById: null },
      // Financial: AMLA §9 floor.
      {
        action: "LOAN_APPROVAL_STEP",
        createdAt: ancient,
        impersonatedById: null,
      },
      { action: "JOURNAL_REVERSE", createdAt: ancient, impersonatedById: null },
      // Security / impersonation: §56 sensitive action.
      {
        action: "PLATFORM_TENANT_IMPERSONATE",
        createdAt: ancient,
        impersonatedById: null,
      },
      // Privacy: the proof a DSAR was answered.
      { action: "CUSTOMER_ERASE", createdAt: ancient, impersonatedById: null },
      // An action this codebase has never heard of — the shape the
      // branch adding money-path audit events will produce. It must
      // survive WITHOUT anyone editing this file.
      {
        action: "DISBURSEMENT_POSTED",
        createdAt: ancient,
        impersonatedById: null,
      },
    ];
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
      auditRows,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });

    // Only the two noise rows went.
    expect(r.deleted.auditEvents).toBe(2);
    expect(auditRows.map((x) => x.action).sort()).toEqual([
      "CUSTOMER_ERASE",
      "DISBURSEMENT_POSTED",
      "JOURNAL_REVERSE",
      "LOAN_APPROVAL_STEP",
      "PLATFORM_TENANT_IMPERSONATE",
    ]);
  });

  it("keeps an otherwise-disposable row created under impersonation", async () => {
    const auditRows: AuditRow[] = [
      {
        action: "REPORT_GENERATED",
        createdAt: ancient,
        impersonatedById: null,
      },
      // Same action, but rendered by vendor support acting AS the user.
      // Privileged-access evidence outranks the action classification.
      {
        action: "REPORT_GENERATED",
        createdAt: ancient,
        impersonatedById: "vendor-staff-1",
      },
    ];
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
      auditRows,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });
    expect(r.deleted.auditEvents).toBe(1);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.impersonatedById).toBe("vendor-staff-1");
  });

  it("narrows the delete by action and impersonation, not by date alone", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 30,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    await svc.runPurge({ actorId: "system" });

    const where = prisma.auditEvent.deleteMany.mock.calls[0]![0].where;
    expect(where.impersonatedById).toBeNull();
    expect(where.action?.in).toEqual([...OPERATIONAL_AUDIT_ACTIONS]);
    // `in` over a closed disposable list, never `notIn` over a
    // protected one — you cannot enumerate the actions that do not
    // exist yet, so preservation has to be the default.
    expect(where.action).not.toHaveProperty("notIn");
  });

  it("echoes the in-scope action list so the purge audit row explains itself", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });
    expect(r.auditActionsInScope).toEqual([...OPERATIONAL_AUDIT_ACTIONS]);
    expect(r.auditActionsInScope).toContain("REPORT_GENERATED");
    expect(r.auditActionsInScope).not.toContain("LOAN_APPROVAL_STEP");
  });
});
