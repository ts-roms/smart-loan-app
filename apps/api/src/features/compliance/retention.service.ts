import { type AuditLogRepository, type PrismaClient } from "@loan/db";

/**
 * Data-retention enforcement.
 *
 * Runs nightly via the `data-retention-purge` scheduled job. Reads the
 * per-tenant retention policy from `SystemConfig` and deletes:
 *
 *   - AuditEvent rows older than `auditRetentionDays` (default 1825 d / 5 y)
 *   - Notification rows older than `notificationRetentionDays` (default 365 d)
 *   - JobRun rows older than `jobRunRetentionDays` (default 90 d)
 *
 * Each knob can be set to `0` to disable purge for that table — useful
 * during regulatory holds where everything must be retained pending
 * investigation. Below the AMLA-floor for audit (1825 d), the settings
 * UI surfaces a "retention below regulatory minimum" warning, but the
 * service still honors the value (compliance decisions are the
 * operator's, not the platform's).
 *
 * ## Why DELETE, not soft-delete?
 *
 * The whole point of retention enforcement is to actually reduce data
 * volume on disk + meet "data minimization" obligations. Soft-deletes
 * would defeat both. The deletion is intentional and audited.
 *
 * ## Audit trail of the purge itself
 *
 * Every run writes a single `RETENTION_PURGE` audit row capturing the
 * row counts per table, the cutoff dates used, and the actor (system
 * sentinel). The audit row is itself subject to retention — meaning
 * eventually the proof of an old purge will roll off too. That's
 * fine: the regulator only ever cares about the current window.
 *
 * The purge is INTENTIONALLY non-transactional. A 10M-row delete
 * inside a transaction would lock the table; instead we batch via
 * `deleteMany` per table, each call being its own implicit
 * transaction. If the process crashes mid-purge, the next nightly
 * tick picks up where it left off (idempotent — same cutoff applied).
 */

const dayMs = 86_400_000;

export interface RetentionPurgeResult {
  startedAt: string;
  finishedAt: string;
  policy: {
    auditRetentionDays: number;
    notificationRetentionDays: number;
    jobRunRetentionDays: number;
  };
  cutoffs: {
    audit: string | null;
    notification: string | null;
    jobRun: string | null;
  };
  deleted: {
    auditEvents: number;
    notifications: number;
    jobRuns: number;
  };
}

export interface RetentionPolicyView {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
  /** Surfaced in the UI as "policy is below the AMLA §9 minimum." */
  auditBelowAmlaFloor: boolean;
}

export const AMLA_AUDIT_FLOOR_DAYS = 1825;

export interface UpdateRetentionInput {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
}

export class RetentionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogRepository,
  ) {}

  /** Read the current policy (singleton row). */
  async getPolicy(): Promise<RetentionPolicyView> {
    const cfg = await this.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: {
        auditRetentionDays: true,
        notificationRetentionDays: true,
        jobRunRetentionDays: true,
      },
    });
    return {
      ...cfg,
      auditBelowAmlaFloor:
        cfg.auditRetentionDays > 0 &&
        cfg.auditRetentionDays < AMLA_AUDIT_FLOOR_DAYS,
    };
  }

  /**
   * Update the policy. Doesn't enforce the AMLA floor — that's a
   * compliance officer's call, not the platform's. The UI shows a
   * warning; the audit row captures the value chosen so the
   * regulator's reviewer can see who lowered it and when.
   */
  async updatePolicy(args: {
    input: UpdateRetentionInput;
    actorId: string;
  }): Promise<RetentionPolicyView> {
    const updated = await this.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: {
        auditRetentionDays: args.input.auditRetentionDays,
        notificationRetentionDays: args.input.notificationRetentionDays,
        jobRunRetentionDays: args.input.jobRunRetentionDays,
        updatedById: args.actorId,
      },
      create: {
        id: "singleton",
        auditRetentionDays: args.input.auditRetentionDays,
        notificationRetentionDays: args.input.notificationRetentionDays,
        jobRunRetentionDays: args.input.jobRunRetentionDays,
        updatedById: args.actorId,
      },
      select: {
        auditRetentionDays: true,
        notificationRetentionDays: true,
        jobRunRetentionDays: true,
      },
    });
    await this.audit.record({
      action: "RETENTION_POLICY_UPDATE",
      actorId: args.actorId,
      targetType: "SystemConfig",
      payload: { ...args.input },
    });
    return {
      ...updated,
      auditBelowAmlaFloor:
        updated.auditRetentionDays > 0 &&
        updated.auditRetentionDays < AMLA_AUDIT_FLOOR_DAYS,
    };
  }

  /**
   * Execute the purge against the current policy. Each table is
   * processed independently — a failure in one doesn't roll back
   * deletions in another. Returns a summary so the scheduled job
   * can record it as the `JobRun.result`.
   *
   * Called from:
   *   - The `data-retention-purge` scheduled job (nightly, system actor)
   *   - The admin "run now" endpoint (manual; actor = the admin)
   */
  async runPurge(args: { actorId: string }): Promise<RetentionPurgeResult> {
    const startedAt = new Date();
    const policy = await this.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: {},
      create: { id: "singleton" },
      select: {
        auditRetentionDays: true,
        notificationRetentionDays: true,
        jobRunRetentionDays: true,
      },
    });

    // Compute cutoffs once. Each `null` slot in the result means "this
    // table is opted-out (days=0)" — useful for the audit trail to
    // distinguish "we ran but found nothing" from "we didn't try."
    const auditCutoff =
      policy.auditRetentionDays > 0
        ? new Date(startedAt.getTime() - policy.auditRetentionDays * dayMs)
        : null;
    const notifCutoff =
      policy.notificationRetentionDays > 0
        ? new Date(
            startedAt.getTime() - policy.notificationRetentionDays * dayMs,
          )
        : null;
    const jobRunCutoff =
      policy.jobRunRetentionDays > 0
        ? new Date(startedAt.getTime() - policy.jobRunRetentionDays * dayMs)
        : null;

    let auditEventsDeleted = 0;
    let notificationsDeleted = 0;
    let jobRunsDeleted = 0;

    if (auditCutoff) {
      const r = await this.prisma.auditEvent.deleteMany({
        where: { createdAt: { lt: auditCutoff } },
      });
      auditEventsDeleted = r.count;
    }
    if (notifCutoff) {
      const r = await this.prisma.notification.deleteMany({
        where: { createdAt: { lt: notifCutoff } },
      });
      notificationsDeleted = r.count;
    }
    if (jobRunCutoff) {
      const r = await this.prisma.jobRun.deleteMany({
        where: { startedAt: { lt: jobRunCutoff } },
      });
      jobRunsDeleted = r.count;
    }

    const finishedAt = new Date();
    const result: RetentionPurgeResult = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      policy,
      cutoffs: {
        audit: auditCutoff?.toISOString() ?? null,
        notification: notifCutoff?.toISOString() ?? null,
        jobRun: jobRunCutoff?.toISOString() ?? null,
      },
      deleted: {
        auditEvents: auditEventsDeleted,
        notifications: notificationsDeleted,
        jobRuns: jobRunsDeleted,
      },
    };

    // Audit AFTER the deletes. If the audit write itself fails, the
    // deletes already landed — we accept the loss of one trail row
    // over leaving a million stale records in place.
    await this.audit.record({
      action: "RETENTION_PURGE",
      actorId: args.actorId,
      targetType: "SystemConfig",
      payload: { ...result },
    });

    return result;
  }
}
