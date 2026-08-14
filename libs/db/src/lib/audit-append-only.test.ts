/**
 * The append-only guard, proven against a real Postgres.
 *
 * This suite exists because a test that drives a Prisma stand-in proves
 * nothing here. A fake `deleteMany` refuses whatever we tell it to refuse; the
 * entire point of 20260814160000_audit_append_only is that the refusal happens
 * BELOW the application, on the path a repair script or a stray `deleteMany`
 * takes without going anywhere near TypeScript. So the database has to be the
 * thing that answers. Same reasoning, and the same harness, as
 * ./integrity-constraints.test.ts.
 *
 * What is proven:
 *
 *   1. An UPDATE is refused.
 *   2. A DELETE outside the purge is refused.
 *   3. A DELETE inside a claimed purge transaction succeeds.
 *   4. A protected action survives a purge that reaches its neighbours.
 *   5. The claim does not leak: a session-scoped `SET` of the same GUC arms
 *      nothing, because the value is bound to a transaction id.
 *   6. The redaction window nulls the two PII columns and cannot be used to
 *      rewrite anything else — the trigger checks the shape, not just the flag.
 *   7. Neither window grants the other's power.
 *   8. TRUNCATE is refused.
 *
 * ── How this stays safe to run against a live database ──────────────────
 *
 * Every case runs inside an interactive transaction that ALWAYS rolls back:
 * the body throws `Rollback` after asserting, so nothing it wrote survives and
 * no row that was already there is touched. Row counts before and after a run
 * are identical.
 *
 * That has a consequence worth stating, because it looks like sloppiness: a
 * failed statement aborts the enclosing Postgres transaction, so a statement
 * we expect to be REFUSED has to be the last one in its transaction. Hence one
 * transaction per assertion.
 *
 * ── Why it skips instead of failing when there is no database ───────────
 *
 * `nx test` runs with no DATABASE_URL and no Postgres. Rather than pretend,
 * the suite skips when it cannot reach one, and runs for real when pointed at
 * one:
 *
 *   DATABASE_URL=postgres://loan:loan@127.0.0.1:5433/smart_loan \
 *     pnpm --filter @loan/db test -- audit-append-only
 *
 * (127.0.0.1, not localhost — the dev Postgres refuses the latter and reports
 * it as a P1000 auth failure, which is a red herring.)
 */

import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

import {
  AUDIT_PURGE_SETTING,
  claimAuditPurgeWindow,
  claimAuditRedactionWindow,
} from "./audit-append-only";

/** Thrown to unwind the transaction once the assertion has been made. */
class Rollback extends Error {}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

const prisma = process.env.DATABASE_URL ? new PrismaClient() : null;

/**
 * An actor to hang audit rows on. `AuditEvent.actorId` is a NOT NULL foreign
 * key, so there is no writing one without a real user.
 */
const seed = prisma
  ? await (async () => {
      try {
        const user = await prisma.user.findFirst({ select: { id: true } });
        return user ? { userId: user.id } : null;
      } catch {
        return null;
      }
    })()
  : null;

afterAll(async () => {
  await prisma?.$disconnect();
});

/** Run `fn` in a transaction that is always rolled back. */
async function inRollback(fn: (tx: Tx) => Promise<void>) {
  try {
    await prisma!.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

const uniq = () => Math.random().toString(36).slice(2, 10).toUpperCase();

/**
 * The trigger raises a plpgsql exception, which Prisma surfaces as a raw
 * connector error rather than one of its own `P2xxx` codes — the SQLSTATE and
 * the message text are both embedded in the stringified error.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Assert the refusal carries the SQLSTATE the migration defines.
 *
 * `AP001` = append-only violation, `AP002` = the redaction changed something
 * it should not have. Asserted rather than the prose because the code is the
 * stable half of the contract — it is what production alerting keys on — and
 * because Prisma backslash-escapes the quoted column names inside the message,
 * so matching the sentence means matching Prisma's escaping too.
 *
 * The code is spelled two different ways depending on which Prisma entry point
 * raised it — `code: "AP001"` from the query engine's connector error, and
 * "Code: `AP001`" from `$executeRawUnsafe`. Accept either rather than pick one
 * and have the TRUNCATE case quietly assert nothing.
 */
function expectSqlState(err: unknown, code: "AP001" | "AP002") {
  expect(err, "the operation must have been refused").not.toBeNull();
  expect(messageOf(err)).toMatch(new RegExp(`[Cc]ode: ["\`]${code}["\`]`));
}

async function attempt(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** One audit row, with the two PII columns populated. */
async function writeAudit(
  tx: Tx,
  action: string,
  extra: { impersonatedById?: string | null } = {},
) {
  return tx.auditEvent.create({
    data: {
      action,
      actorId: seed!.userId,
      targetType: "Test",
      targetId: `append-only-${uniq()}`,
      ipAddress: "203.0.113.9",
      userAgent: "vitest/append-only",
      // Old enough that any realistic retention cutoff reaches it.
      createdAt: new Date("2015-01-01T00:00:00Z"),
      ...extra,
    },
    select: { id: true, action: true },
  });
}

describe.skipIf(!seed)("AuditEvent refuses to be rewritten", () => {
  it("refuses an UPDATE", async () => {
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "REPORT_GENERATED");

      // Must be last — it aborts the transaction.
      const err = await attempt(
        tx.auditEvent.update({
          where: { id: row.id },
          data: { action: "TAMPERED" },
        }),
      );

      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("UPDATE refused");
    });
  });

  it("refuses an UPDATE even when it is the shape redaction would use", async () => {
    // The flag is not optional for the permitted shape. Otherwise any code
    // path that happened to null both columns would be silently blessed.
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "LOAN_DISBURSE");

      const err = await attempt(
        tx.auditEvent.update({
          where: { id: row.id },
          data: { ipAddress: null, userAgent: null },
        }),
      );

      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("UPDATE refused");
    });
  });

  it("refuses a DELETE outside the purge", async () => {
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "REPORT_GENERATED");

      const err = await attempt(
        tx.auditEvent.delete({ where: { id: row.id } }),
      );

      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("DELETE refused");
    });
  });

  it("refuses a deleteMany that matches rows, and ignores one that matches none", async () => {
    // The second half is not incidental. The trigger is deliberately
    // row-level, so a `deleteMany` whose WHERE matches nothing stays the
    // harmless no-op it is today rather than becoming a hard error — which is
    // what a statement-level guard would have made it.
    await inRollback(async (tx) => {
      await expect(
        tx.auditEvent.deleteMany({ where: { id: `nonexistent-${uniq()}` } }),
      ).resolves.toEqual({ count: 0 });

      const row = await writeAudit(tx, "REPORT_GENERATED");
      const err = await attempt(
        tx.auditEvent.deleteMany({ where: { id: row.id } }),
      );
      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("DELETE refused");
    });
  });

  it("refuses TRUNCATE", async () => {
    await inRollback(async (tx) => {
      // A row trigger cannot see TRUNCATE; a separate statement trigger does.
      const err = await attempt(
        tx.$executeRawUnsafe('TRUNCATE "AuditEvent" CASCADE'),
      );
      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("TRUNCATE refused");
    });
  });
});

describe.skipIf(!seed)("the retention purge is the one path through", () => {
  it("deletes when the transaction has claimed the purge window", async () => {
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "REPORT_GENERATED");

      await claimAuditPurgeWindow(tx);

      await expect(
        tx.auditEvent.delete({ where: { id: row.id } }),
      ).resolves.toBeTruthy();
    });
  });

  it("leaves a protected action standing while its neighbours go", async () => {
    // The whole design in one case: same cutoff, same transaction, same
    // claimed window — and the row that evidences money moving is still there
    // afterwards because the closed operational list never named it.
    await inRollback(async (tx) => {
      const disposable = await writeAudit(tx, "REPORT_GENERATED");
      const financial = await writeAudit(tx, "LOAN_DISBURSE");
      const unclassified = await writeAudit(tx, "ACCOUNTING_PERIOD_CLOSE");
      // Operational action, but performed under impersonation — protected by
      // the per-row half of the carve-out rather than the per-action half.
      const impersonated = await writeAudit(tx, "REPORT_GENERATED", {
        impersonatedById: seed!.userId,
      });

      await claimAuditPurgeWindow(tx);
      await tx.auditEvent.deleteMany({
        where: {
          id: {
            in: [disposable.id, financial.id, unclassified.id, impersonated.id],
          },
          // The purge's real predicate, mirroring purgeableAuditWhere.
          action: {
            in: [
              "ASSISTANT_DRAFT_DEMAND_LETTER",
              "ASSISTANT_EXPLAIN_DECISION",
              "ASSISTANT_SUMMARIZE_ACCOUNT",
              "REPORT_GENERATED",
              "RBAC_SYNC",
              "RETENTION_PURGE",
            ],
          },
          impersonatedById: null,
          createdAt: { lt: new Date("2020-01-01T00:00:00Z") },
        },
      });

      const survivors = await tx.auditEvent.findMany({
        where: {
          id: {
            in: [disposable.id, financial.id, unclassified.id, impersonated.id],
          },
        },
        select: { id: true },
      });
      const ids = survivors.map((s) => s.id).sort();
      expect(ids).toEqual(
        [financial.id, unclassified.id, impersonated.id].sort(),
      );
    });
  });

  it("does not let the claim leak to a later transaction on the same connection", async () => {
    // The failure this defends against is someone writing session-scoped `SET`
    // where `SET LOCAL` was meant — on a pooled connection that would arm
    // every later borrower of the connection, including another tenant's
    // request. Binding the value to a transaction id makes a leaked setting
    // match nothing.
    await inRollback(async (tx) => {
      // Session-scoped (is_local = false): survives past this statement.
      await tx.$executeRawUnsafe(
        `SELECT set_config('${AUDIT_PURGE_SETTING}', pg_current_xact_id()::text, false)`,
      );
      const row = await writeAudit(tx, "REPORT_GENERATED");

      // Still the same transaction here, so this one legitimately passes —
      // the point is proven by the outer-transaction case below.
      await expect(
        tx.auditEvent.delete({ where: { id: row.id } }),
      ).resolves.toBeTruthy();
    });

    // New transaction, same pool. The setting left behind above (if the
    // connection is reused) names a transaction that has committed, so it
    // authorises nothing.
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "REPORT_GENERATED");
      const err = await attempt(
        tx.auditEvent.delete({ where: { id: row.id } }),
      );
      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("DELETE refused");
    });
  });

  it("refuses a delete claimed on a DIFFERENT connection", async () => {
    // The claim has to be made on the same client that does the write.
    // Claiming on `prisma` (its own implicit transaction, immediately
    // committed) and deleting inside `tx` must not work.
    await claimAuditPurgeWindow(prisma!);
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "REPORT_GENERATED");
      const err = await attempt(
        tx.auditEvent.delete({ where: { id: row.id } }),
      );
      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("DELETE refused");
    });
  });
});

describe.skipIf(!seed)("PII redaction keeps the row", () => {
  it("nulls ipAddress and userAgent and changes nothing else", async () => {
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "LOAN_DISBURSE");
      const before = await tx.auditEvent.findUniqueOrThrow({
        where: { id: row.id },
      });

      await claimAuditRedactionWindow(tx);
      const r = await tx.auditEvent.updateMany({
        where: { id: row.id },
        data: { ipAddress: null, userAgent: null },
      });
      expect(r.count).toBe(1);

      const after = await tx.auditEvent.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.ipAddress).toBeNull();
      expect(after.userAgent).toBeNull();
      // The §56 half is intact: same row, same action, same actor, same time.
      expect(after.id).toBe(before.id);
      expect(after.action).toBe(before.action);
      expect(after.actorId).toBe(before.actorId);
      expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    });
  });

  it("refuses a redaction that also rewrites another column", async () => {
    // The flag authorises the operation; the trigger independently authorises
    // the shape. Holding the window is not a licence to edit the record.
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "LOAN_DISBURSE");
      await claimAuditRedactionWindow(tx);

      const err = await attempt(
        tx.auditEvent.updateMany({
          where: { id: row.id },
          data: { ipAddress: null, userAgent: null, action: "TAMPERED" },
        }),
      );
      expectSqlState(err, "AP002");
      expect(messageOf(err)).toContain("redaction may only set");
    });
  });

  it("refuses a redaction that only nulls one of the two", async () => {
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "LOAN_DISBURSE");
      await claimAuditRedactionWindow(tx);

      const err = await attempt(
        tx.auditEvent.updateMany({
          where: { id: row.id },
          data: { ipAddress: null },
        }),
      );
      expectSqlState(err, "AP002");
      expect(messageOf(err)).toContain("redaction may only set");
    });
  });
});

describe.skipIf(!seed)("the two windows are separate powers", () => {
  it("the redaction window cannot delete", async () => {
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "REPORT_GENERATED");
      await claimAuditRedactionWindow(tx);

      const err = await attempt(
        tx.auditEvent.delete({ where: { id: row.id } }),
      );
      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("DELETE refused");
    });
  });

  it("the purge window cannot redact", async () => {
    await inRollback(async (tx) => {
      const row = await writeAudit(tx, "LOAN_DISBURSE");
      await claimAuditPurgeWindow(tx);

      const err = await attempt(
        tx.auditEvent.updateMany({
          where: { id: row.id },
          data: { ipAddress: null, userAgent: null },
        }),
      );
      expectSqlState(err, "AP001");
      expect(messageOf(err)).toContain("UPDATE refused");
    });
  });
});
