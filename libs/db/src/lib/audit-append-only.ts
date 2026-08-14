/**
 * Claiming the two escape hatches in `AuditEvent`'s append-only trigger.
 *
 * `20260814160000_audit_append_only` puts a BEFORE UPDATE OR DELETE trigger on
 * `AuditEvent` that refuses both unless the transaction has announced itself.
 * These two functions are the announcement, and the only supported way to make
 * it. Everything about the shape is explained at length in the migration; what
 * follows is what a caller has to get right.
 *
 * ## The contract
 *
 * Both helpers set a custom GUC to the CURRENT TRANSACTION ID, locally:
 *
 *   SELECT set_config('<name>', pg_current_xact_id()::text, true)
 *
 * and the trigger allows the operation only while the setting still equals
 * `pg_current_xact_id()`. Two consequences that matter:
 *
 *   1. **It must be the same transaction, not merely the same connection.**
 *      `prisma.$executeRaw` outside a transaction runs in its own implicit
 *      one, which commits immediately and reverts the setting — so calling
 *      `claimAuditPurgeWindow(prisma)` and then `prisma.auditEvent.deleteMany`
 *      does NOT work, and fails closed (the delete is refused) rather than
 *      open. Pass the `tx` from an interactive `prisma.$transaction(async tx
 *      => …)` and do the write on that same `tx`.
 *
 *   2. **It cannot leak.** The reason for binding to the transaction id rather
 *      than using a plain boolean is the failure that `SET LOCAL` alone does
 *      not cover: someone writing session-scoped `SET` instead. On a pooled
 *      connection — more so behind PgBouncer in transaction mode — that
 *      setting outlives the request and would silently arm every later
 *      transaction that borrows the connection. A transaction id matches
 *      exactly one transaction, so a leaked value arms nothing.
 *
 * ## Least authority
 *
 * They are two separate windows, not one flag with two meanings, so the
 * redaction path cannot delete and the purge cannot rewrite. And the redaction
 * window is not a licence to update: the trigger independently checks that the
 * update nulls `ipAddress` and `userAgent` and changes nothing else, so
 * holding it cannot rewrite `action`, `payload` or `createdAt`.
 *
 * ## If a claim is refused
 *
 * The trigger raises SQLSTATE `AP001` (append-only violation) or `AP002`
 * (redaction changed something it shouldn't). Neither is retryable and neither
 * should be swallowed — `AP001` reaching production means something tried to
 * mutate the audit log, which is worth waking someone for.
 */

/**
 * The subset of a Prisma client (or interactive transaction client) these
 * helpers need. Typed structurally rather than as `PrismaClient` so a
 * transaction client, an extended client, or a test double all satisfy it
 * without a cast.
 */
export interface AuditWindowClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** GUC that authorises DELETE on `AuditEvent`. Held by the retention purge. */
export const AUDIT_PURGE_SETTING = "app.audit_retention_purge";

/**
 * GUC that authorises the §71 PII redaction UPDATE on `AuditEvent`. Held by
 * the retention purge's redaction leg.
 */
export const AUDIT_REDACTION_SETTING = "app.audit_pii_redaction";

/**
 * `$executeRawUnsafe` with a compile-time constant — there is no
 * interpolation, no caller input, and nothing to inject. It is `Unsafe`
 * only because the string is not a tagged template; the alternative,
 * `$executeRaw`, cannot take a value built from a constant without the same
 * literal appearing twice.
 */
function claimSql(setting: string): string {
  return `SELECT set_config('${setting}', pg_current_xact_id()::text, true)`;
}

/**
 * Announce that this transaction is the retention purge, permitting it to
 * DELETE from `AuditEvent`.
 *
 * Scoped to `tx`'s transaction and nothing beyond it. Call it as the first
 * statement of the transaction that does the deleting.
 *
 * Note what this does NOT do: it does not widen WHICH rows may go. The closed
 * operational-action list in `apps/api/src/features/compliance/audit-retention.ts`
 * is still what decides that, and it is enforced in the `where` clause. This
 * only lifts the blanket refusal.
 */
export async function claimAuditPurgeWindow(
  tx: AuditWindowClient,
): Promise<void> {
  await tx.$executeRawUnsafe(claimSql(AUDIT_PURGE_SETTING));
}

/**
 * Announce that this transaction is the §71 redaction pass, permitting it to
 * null `ipAddress` and `userAgent` on `AuditEvent` rows.
 *
 * Only that. The trigger verifies the shape of every updated row
 * independently, so this window cannot be used to change anything else even
 * by accident.
 */
export async function claimAuditRedactionWindow(
  tx: AuditWindowClient,
): Promise<void> {
  await tx.$executeRawUnsafe(claimSql(AUDIT_REDACTION_SETTING));
}
