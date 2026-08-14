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

/** The complement of `AuditDeleteWhere` — the rows redaction reaches. */
interface AuditRedactWhere {
  createdAt: { lt: Date };
  NOT: { action: { in: string[] }; impersonatedById: null };
  OR: unknown[];
}

/** The only column patch the append-only trigger will accept. */
interface AuditRedactData {
  ipAddress: null;
  userAgent: null;
}

function makePrisma(opts: {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
  /** Defaults to 730, matching the SystemConfig default. */
  loginAttemptRetentionDays?: number;
  /** When supplied, `auditEvent.deleteMany` really filters these. */
  auditRows?: AuditRow[];
}) {
  // upsert returns the same row regardless of update/create — we're
  // only testing what runPurge does with the returned policy values.
  const cfg = {
    auditRetentionDays: opts.auditRetentionDays,
    notificationRetentionDays: opts.notificationRetentionDays,
    jobRunRetentionDays: opts.jobRunRetentionDays,
    loginAttemptRetentionDays: opts.loginAttemptRetentionDays ?? 730,
  };
  const auditRows = opts.auditRows;
  const client = {
    systemConfig: {
      upsert: vi.fn(async () => cfg),
    },
    /**
     * The GUC claim. A stand-in cannot prove the trigger accepts it — that is
     * what libs/db/src/lib/audit-append-only.test.ts is for, against a real
     * Postgres. What this CAN prove, and does below, is that the claim is
     * issued on the transaction client and issued BEFORE the write, which is
     * the half of the contract that lives in this file.
     */
    $executeRawUnsafe: vi.fn(async (_sql: string) => 1),
    /**
     * Interactive transaction. Hands the callback this same object, so the
     * claim and the write are recorded against one call log and their ORDER
     * is observable.
     */
    $transaction: vi.fn(
      async (
        fn: (tx: unknown) => Promise<unknown>,
        _opts?: { timeout?: number },
      ) => fn(client),
    ),
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
      updateMany: vi.fn(
        async (_arg: { where: AuditRedactWhere; data: AuditRedactData }) => ({
          count: 5,
        }),
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
    loginAttempt: {
      deleteMany: vi.fn(
        async (_arg: { where: { createdAt: { lt: Date } } }) => ({ count: 9 }),
      ),
    },
  };
  return client;
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
      loginAttempts: 9,
    });
    // Redactions are reported next to deletions, never inside them.
    expect(r.redacted).toEqual({ auditEvents: 5 });
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

/**
 * The half of the append-only contract that lives in this file.
 *
 * Whether the trigger honours a claim is a question only Postgres can answer,
 * and libs/db/src/lib/audit-append-only.test.ts asks it there. What is
 * checkable here is that the service holds up its end: it opens a real
 * transaction, claims BEFORE it writes, and does both on the same client.
 * Getting any of those wrong fails closed in production — the delete is
 * refused — so the value of catching it here is turning a broken nightly job
 * into a red test.
 */
describe("runPurge claims the database windows correctly", () => {
  it("wraps each AuditEvent leg in its own transaction with a raised timeout", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    await svc.runPurge({ actorId: "system" });

    // Two: the delete leg and the redaction leg. Separate transactions so
    // each holds only its own window — the delete cannot rewrite and the
    // redaction cannot delete.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    for (const call of prisma.$transaction.mock.calls) {
      // Prisma's default interactive-transaction timeout is 5s, which a
      // five-year sweep will exceed on any real book.
      expect(call[1]?.timeout).toBeGreaterThan(5_000);
    }
  });

  it("claims the purge window before deleting, and the redaction window before updating", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    await svc.runPurge({ actorId: "system" });

    const claims = prisma.$executeRawUnsafe.mock.calls.map((c) => c[0]);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toContain("app.audit_retention_purge");
    expect(claims[1]).toContain("app.audit_pii_redaction");
    // Bound to the transaction id, not a boolean — that is what stops a
    // session-scoped `SET` from arming a later borrower of a pooled
    // connection.
    for (const sql of claims) {
      expect(sql).toContain("pg_current_xact_id()");
      // Third argument `true` = is_local: reverts at COMMIT/ROLLBACK.
      expect(sql).toContain("true");
    }

    // Order matters and is not incidental: a claim issued after the write
    // authorises nothing.
    const claimOrder = prisma.$executeRawUnsafe.mock.invocationCallOrder;
    expect(claimOrder[0]).toBeLessThan(
      prisma.auditEvent.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(claimOrder[1]).toBeLessThan(
      prisma.auditEvent.updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it("does not open a transaction or claim anything when the audit clock is off", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 0,
      notificationRetentionDays: 365,
      jobRunRetentionDays: 90,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.auditEvent.updateMany).not.toHaveBeenCalled();
    // A regulatory hold freezes minimisation too. Under a hold nothing is
    // deleted AND nothing is redacted, which is the correct reading of a
    // hold — not "keep the rows but scrub them".
    expect(r.redacted.auditEvents).toBe(0);
  });
});

describe("the §71 redaction pass", () => {
  it("nulls only the two PII columns, and never deletes", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });

    const call = prisma.auditEvent.updateMany.mock.calls[0]![0];
    // Exactly the shape the trigger permits. Anything else is refused at
    // the database even though the service holds the window.
    expect(call.data).toEqual({ ipAddress: null, userAgent: null });
    expect(r.redacted.auditEvents).toBe(5);
  });

  it("targets the rows the purge is NOT allowed to delete", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    await svc.runPurge({ actorId: "system" });

    const where = prisma.auditEvent.updateMany.mock.calls[0]![0].where;
    // Same clock as the delete leg.
    const deleteWhere = prisma.auditEvent.deleteMany.mock.calls[0]![0].where;
    expect(where.createdAt.lt.getTime()).toBe(
      deleteWhere.createdAt.lt.getTime(),
    );
    // The complement of the carve-out: protected rows, and only those.
    expect(where.NOT.action.in).toEqual([...OPERATIONAL_AUDIT_ACTIONS]);
    expect(where.NOT.impersonatedById).toBeNull();
    // And only rows that actually carry something to clear.
    expect(where.OR).toHaveLength(2);
  });

  it("keeps redaction counts out of the deletion counts", async () => {
    // A regulator reading "42 audit events deleted" must be reading a
    // deletion count. Folding redactions in would make the one number an
    // operator most needs to trust unreadable.
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });
    expect(r.deleted.auditEvents).toBe(42);
    expect(r.redacted.auditEvents).toBe(5);
  });
});

describe("LoginAttempt runs on its own clock", () => {
  it("sweeps by its own window, not the audit one", async () => {
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
      loginAttemptRetentionDays: 730,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });

    expect(r.deleted.loginAttempts).toBe(9);
    const loginCutoff =
      prisma.loginAttempt.deleteMany.mock.calls[0]![0].where.createdAt.lt;
    const auditCutoff =
      prisma.auditEvent.deleteMany.mock.calls[0]![0].where.createdAt.lt;
    // 730 days versus 1825 — the whole point of the separate knob.
    expect(loginCutoff.getTime()).toBeGreaterThan(auditCutoff.getTime());
    expect(r.cutoffs.loginAttempt).toBe(loginCutoff.toISOString());
  });

  it("honours its own opt-out independently of the audit one", async () => {
    // A regulatory hold on the security log has nothing to do with a hold
    // on the audit log, and vice versa.
    const prisma = makePrisma({
      auditRetentionDays: 1825,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
      loginAttemptRetentionDays: 0,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    const r = await svc.runPurge({ actorId: "system" });

    expect(prisma.loginAttempt.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(r.cutoffs.loginAttempt).toBeNull();
    expect(r.deleted.loginAttempts).toBe(0);
  });

  it("does not redact login attempts — the whole row is the personal data", async () => {
    // Unlike an audit row, a login attempt evidences no regulated action, so
    // there is no §56 half to preserve once the window passes. Redacting it
    // would leave a row that says nothing.
    const prisma = makePrisma({
      auditRetentionDays: 0,
      notificationRetentionDays: 0,
      jobRunRetentionDays: 0,
      loginAttemptRetentionDays: 730,
    });
    const svc = new RetentionService(prisma as never, makeAudit() as never);

    await svc.runPurge({ actorId: "system" });

    expect(prisma.loginAttempt.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.auditEvent.updateMany).not.toHaveBeenCalled();
  });
});
