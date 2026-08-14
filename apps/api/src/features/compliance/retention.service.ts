import {
  type AuditLogRepository,
  type PrismaClient,
  claimAuditPurgeWindow,
  claimAuditRedactionWindow,
} from "@loan/db";

import {
  OPERATIONAL_AUDIT_ACTIONS,
  purgeableAuditWhere,
  redactableAuditWhere,
} from "./audit-retention";

/**
 * Data-retention enforcement.
 *
 * Runs nightly via the `data-retention-purge` scheduled job. Reads the
 * per-tenant retention policy from `SystemConfig` and deletes:
 *
 *   - AuditEvent rows older than `auditRetentionDays` (default 1825 d / 5 y)
 *     AND classified as operational — see the carve-out below
 *   - Notification rows older than `notificationRetentionDays` (default 365 d)
 *   - JobRun rows older than `jobRunRetentionDays` (default 90 d)
 *   - LoginAttempt rows older than `loginAttemptRetentionDays` (default
 *     730 d) — its own clock, for the reasons on the SystemConfig field
 *
 * and REDACTS, without deleting:
 *
 *   - `ipAddress` / `userAgent` on the AuditEvent rows past the audit
 *     cutoff that the carve-out protects from deletion — see below
 *
 * Each knob can be set to `0` to disable purge for that table — useful
 * during regulatory holds where everything must be retained pending
 * investigation.
 *
 * ## The audit carve-out (§56 vs §71)
 *
 * §56 makes the audit log append-only and requires every sensitive
 * action to be audited; §71 requires retention policies that actually
 * delete. This service used to satisfy only the second: one unqualified
 * `deleteMany` on `createdAt < cutoff`, so a loan approval and a
 * "someone ran a report" row expired on the same clock, and the AMLA
 * floor was a cosmetic boolean on the policy view that nothing read.
 *
 * The reconciliation is that the clock is not allowed to reach rows
 * that must survive. `purgeableAuditWhere` narrows the delete to a
 * closed list of operational actions plus a non-impersonated
 * requirement; everything else — including every action added after
 * this was written — is out of reach at any retention setting. See
 * audit-retention.ts for why the list is closed in that direction.
 *
 * That makes the day count a policy for noise only, which is why the
 * AMLA floor moved from a warning to a refusal in `updatePolicy`: with
 * regulated rows structurally unreachable, the remaining purpose of the
 * floor is to catch a row this codebase MISCLASSIFIED as noise. Two
 * independent guards for one obligation.
 *
 * ## The other half of §71: redaction, for the rows that must survive
 *
 * The carve-out answers "may this row be deleted" and stops there. It
 * leaves a five-year-old loan-approval row still carrying the approver's
 * IP address and browser string — personal data, kept indefinitely,
 * because the row it sits on is protected. §71 is not satisfied by
 * pointing at §56.
 *
 * So the protected rows get a retention path of their own: past the same
 * cutoff, `ipAddress` and `userAgent` are set to NULL and everything
 * else is left exactly as it was. The row keeps evidencing who did what
 * and when; it stops carrying where from. `redactableAuditWhere` picks
 * them, and the database independently refuses any update to this table
 * that is not precisely that shape.
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
 * The purge does not span tables in one transaction. Each table is its
 * own unit of work, so a failure in one leaves the others' deletions
 * standing; if the process dies mid-purge the next nightly tick picks up
 * where it left off (idempotent — same cutoff applied).
 *
 * The two AuditEvent legs each open an EXPLICIT transaction, which the
 * comment here used to say they did not. That changed because the
 * database now refuses to mutate `AuditEvent` unless the transaction has
 * claimed a window, and a window is bound to a transaction id — see
 * libs/db/src/lib/audit-append-only.ts. The cost is one extra round trip
 * per leg and a transaction held for the length of one statement, which
 * is what the statement's own implicit transaction held anyway. The
 * `timeout` is raised well past Prisma's 5s default because the whole
 * point of the delete is that it might be large.
 */

const dayMs = 86_400_000;

/**
 * Ceiling on each AuditEvent leg's interactive transaction. Prisma's default
 * is 5s, which is fine for a service call and not for a nightly sweep over a
 * table that has been accumulating for five years. Ten minutes is long enough
 * that a legitimate large delete finishes and short enough that a wedged one
 * gets noticed by the job's own failure path rather than holding a connection
 * until morning.
 */
const PURGE_TRANSACTION_TIMEOUT_MS = 600_000;

export interface RetentionPurgeResult {
  startedAt: string;
  finishedAt: string;
  policy: {
    auditRetentionDays: number;
    notificationRetentionDays: number;
    jobRunRetentionDays: number;
    loginAttemptRetentionDays: number;
  };
  cutoffs: {
    audit: string | null;
    notification: string | null;
    jobRun: string | null;
    loginAttempt: string | null;
  };
  deleted: {
    auditEvents: number;
    notifications: number;
    jobRuns: number;
    loginAttempts: number;
  };
  /**
   * Rows the run REDACTED rather than deleted: protected audit records past
   * the audit cutoff whose `ipAddress`/`userAgent` were nulled in place.
   *
   * Reported separately from `deleted` and never folded into it, because the
   * two are different promises to different regulators. A number here is
   * evidence that §71 minimisation ran; a number in `deleted.auditEvents` is
   * evidence that a §56 record went away. Adding them would make both
   * unreadable.
   */
  redacted: {
    auditEvents: number;
  };
  /**
   * The audit actions the run was permitted to delete, echoed so the
   * purge's own audit row is self-explaining: a reviewer asking "why is
   * this five-year-old approval still here" gets the answer from the
   * record rather than from the source.
   */
  auditActionsInScope: string[];
}

export interface RetentionPolicyView {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
  loginAttemptRetentionDays: number;
  /** Surfaced in the UI as "policy is below the AMLA §9 minimum." */
  auditBelowAmlaFloor: boolean;
}

export const AMLA_AUDIT_FLOOR_DAYS = 1825;

export interface UpdateRetentionInput {
  auditRetentionDays: number;
  notificationRetentionDays: number;
  jobRunRetentionDays: number;
  /**
   * Optional where the other three are required, and deliberately so: this
   * knob arrived after the endpoint did, and making it mandatory would turn
   * every existing PUT body into a 400. Omitted means "leave it as it is",
   * which is also the only sane reading of a body that predates the field.
   */
  loginAttemptRetentionDays?: number;
}

export type UpdateRetentionResult =
  | { ok: true; policy: RetentionPolicyView }
  | {
      ok: false;
      kind: "BelowRegulatoryFloor";
      message: string;
      floorDays: number;
      requestedDays: number;
    };

/**
 * The four knobs, selected identically wherever the policy is read. One
 * constant rather than four copies of the object literal: the failure mode of
 * a copy is a silently missing field on one endpoint, which is how a knob ends
 * up unreadable from exactly the screen that needs to set it.
 */
const POLICY_SELECT = {
  auditRetentionDays: true,
  notificationRetentionDays: true,
  jobRunRetentionDays: true,
  loginAttemptRetentionDays: true,
} as const;

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
      select: POLICY_SELECT,
    });
    return {
      ...cfg,
      auditBelowAmlaFloor:
        cfg.auditRetentionDays > 0 &&
        cfg.auditRetentionDays < AMLA_AUDIT_FLOOR_DAYS,
    };
  }

  /**
   * Update the policy. REFUSES an audit window below the AMLA §9 floor.
   *
   * This used to be a warning: the service honored any value and the UI
   * showed a flag, on the reasoning that compliance decisions belong to
   * the operator. The flag had no teeth — nothing in `runPurge` read
   * it — so "the operator's call" amounted to an unenforced label on an
   * unguarded delete.
   *
   * It is a refusal now because the two halves of the fix support each
   * other. The carve-out makes regulated rows structurally unreachable,
   * so the day count only governs operational noise and there is no
   * legitimate reason to set it below five years. What the floor still
   * buys is defence in depth: if an action in
   * `OPERATIONAL_AUDIT_ACTIONS` turns out to have been misclassified,
   * the floor keeps five years of it anyway. Cheap insurance against
   * the one mistake in this design that cannot be undone.
   *
   * `0` is still accepted — it means "never purge", which is above the
   * floor rather than below it.
   *
   * NOTE for legal review (§70): the specific figure, 1,825 days, was
   * already in this codebase and is carried forward unchanged. Whether
   * AMLA §9 / BSP 706 truly bar an operator from setting a shorter
   * window for non-regulated audit noise — and whether a documented
   * legal opinion should be able to override this refusal — is a
   * question for counsel, not for this service.
   */
  async updatePolicy(args: {
    input: UpdateRetentionInput;
    actorId: string;
  }): Promise<UpdateRetentionResult> {
    const requested = args.input.auditRetentionDays;
    if (requested > 0 && requested < AMLA_AUDIT_FLOOR_DAYS) {
      return {
        ok: false,
        kind: "BelowRegulatoryFloor",
        message:
          `Audit retention of ${requested} days is below the AMLA §9 / BSP Circular 706 ` +
          `floor of ${AMLA_AUDIT_FLOOR_DAYS} days (5 years). Use 0 to disable the audit ` +
          `purge entirely, or a value at or above the floor.`,
        floorDays: AMLA_AUDIT_FLOOR_DAYS,
        requestedDays: requested,
      };
    }

    // `loginAttemptRetentionDays` is spread conditionally rather than passed
    // as `?? undefined`: on the CREATE branch an explicit `undefined` and an
    // absent key behave the same, but writing it out keeps "omitted means
    // leave it alone" true on the UPDATE branch by construction rather than
    // by Prisma's convention.
    const loginAttemptPatch =
      args.input.loginAttemptRetentionDays === undefined
        ? {}
        : { loginAttemptRetentionDays: args.input.loginAttemptRetentionDays };

    const updated = await this.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: {
        auditRetentionDays: args.input.auditRetentionDays,
        notificationRetentionDays: args.input.notificationRetentionDays,
        jobRunRetentionDays: args.input.jobRunRetentionDays,
        ...loginAttemptPatch,
        updatedById: args.actorId,
      },
      create: {
        id: "singleton",
        auditRetentionDays: args.input.auditRetentionDays,
        notificationRetentionDays: args.input.notificationRetentionDays,
        jobRunRetentionDays: args.input.jobRunRetentionDays,
        ...loginAttemptPatch,
        updatedById: args.actorId,
      },
      select: POLICY_SELECT,
    });
    await this.audit.record({
      action: "RETENTION_POLICY_UPDATE",
      actorId: args.actorId,
      targetType: "SystemConfig",
      payload: { ...args.input },
    });
    return {
      ok: true,
      policy: {
        ...updated,
        // Always false on this path now — the guard above rejects the
        // values that would raise it. Kept in the shape because GET and
        // PUT answer the identical schema, and a pre-existing row
        // written before the refusal can still be below the floor.
        auditBelowAmlaFloor:
          updated.auditRetentionDays > 0 &&
          updated.auditRetentionDays < AMLA_AUDIT_FLOOR_DAYS,
      },
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
      select: POLICY_SELECT,
    });

    // Compute cutoffs once. Each `null` slot in the result means "this
    // table is opted-out (days=0)" — useful for the audit trail to
    // distinguish "we ran but found nothing" from "we didn't try."
    const cutoffFor = (days: number) =>
      days > 0 ? new Date(startedAt.getTime() - days * dayMs) : null;
    const auditCutoff = cutoffFor(policy.auditRetentionDays);
    const notifCutoff = cutoffFor(policy.notificationRetentionDays);
    const jobRunCutoff = cutoffFor(policy.jobRunRetentionDays);
    const loginAttemptCutoff = cutoffFor(policy.loginAttemptRetentionDays);

    let auditEventsDeleted = 0;
    let auditEventsRedacted = 0;
    let notificationsDeleted = 0;
    let jobRunsDeleted = 0;
    let loginAttemptsDeleted = 0;

    if (auditCutoff) {
      // The carve-out. NOT `{ createdAt: { lt: cutoff } }` — that form
      // reached every regulated row in the table. `purgeableAuditWhere`
      // adds the closed operational-action list and the
      // non-impersonated requirement, so the clock cannot touch a
      // financial, security or unclassified row at any setting.
      //
      // The transaction is not for atomicity — one `deleteMany` is already
      // atomic. It exists because the append-only trigger refuses this
      // delete unless the transaction has claimed the purge window, and the
      // claim is bound to a transaction id. Claim first, delete second, on
      // the SAME `tx`: doing either on `this.prisma` puts them in different
      // transactions and the delete is refused.
      auditEventsDeleted = await this.prisma.$transaction(
        async (tx) => {
          await claimAuditPurgeWindow(tx);
          const r = await tx.auditEvent.deleteMany({
            where: purgeableAuditWhere(auditCutoff),
          });
          return r.count;
        },
        { timeout: PURGE_TRANSACTION_TIMEOUT_MS },
      );

      // §71, for the rows §56 will not let go: null the two provenance
      // columns in place. A separate window from the purge's, so this leg
      // cannot delete and the delete leg cannot rewrite; and the trigger
      // checks the shape of every row it touches, so even holding this
      // window it can only null those two columns.
      auditEventsRedacted = await this.prisma.$transaction(
        async (tx) => {
          await claimAuditRedactionWindow(tx);
          const r = await tx.auditEvent.updateMany({
            where: redactableAuditWhere(auditCutoff),
            data: { ipAddress: null, userAgent: null },
          });
          return r.count;
        },
        { timeout: PURGE_TRANSACTION_TIMEOUT_MS },
      );
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
    if (loginAttemptCutoff) {
      // The security log's own clock. No carve-out and no redaction pass:
      // unlike an audit row, a login attempt is not evidence of a regulated
      // action, so once it is past the window there is nothing left in it
      // worth keeping — the whole row is the personal data.
      const r = await this.prisma.loginAttempt.deleteMany({
        where: { createdAt: { lt: loginAttemptCutoff } },
      });
      loginAttemptsDeleted = r.count;
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
        loginAttempt: loginAttemptCutoff?.toISOString() ?? null,
      },
      deleted: {
        auditEvents: auditEventsDeleted,
        notifications: notificationsDeleted,
        jobRuns: jobRunsDeleted,
        loginAttempts: loginAttemptsDeleted,
      },
      redacted: {
        auditEvents: auditEventsRedacted,
      },
      auditActionsInScope: [...OPERATIONAL_AUDIT_ACTIONS],
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
