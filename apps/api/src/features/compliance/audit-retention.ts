/**
 * Which audit rows the retention clock is allowed to reach.
 *
 * ## The tension this resolves
 *
 * §56 says the audit log is append-only and every sensitive action is
 * audited. §71 says retention policies must exist and old data must go.
 * Both are right, and `runPurge` used to satisfy only the second: one
 * `deleteMany` on `createdAt < cutoff` with no carve-out, so a loan
 * approval, a platform impersonation and a "someone ran a report" row
 * all expired on the same clock.
 *
 * The resolution is that **not every audit row is equally disposable**.
 * A row evidencing a financial decision or a privileged session has a
 * regulatory floor under AMLA §9 / BSP 706. A row saying a report was
 * rendered does not. So the clock gets a carve-out, and the carve-out
 * is keyed off `action` — the one column that has always described what
 * the row *is*.
 *
 * ## Why the disposable list is closed and everything else survives
 *
 * The obvious shape is a list of protected actions that the purge
 * skips. That shape fails open: the day someone adds
 * `DISBURSEMENT_POSTED` and forgets to add it to the protected list,
 * the nightly job silently starts deleting disbursement records. The
 * failure is invisible, unrecoverable, and discovered by a regulator.
 *
 * So it is inverted. `OPERATIONAL_AUDIT_ACTIONS` is a CLOSED list of
 * actions the purge may touch. Every other action — including every
 * action that does not exist yet — classifies as `UNCLASSIFIED` and is
 * preserved. Forgetting to classify a new action costs disk space,
 * which is recoverable; the opposite mistake is not.
 *
 * ## How this composes with the branch adding money-path audit events
 *
 * That branch adds new `action` values and new columns on `AuditEvent`.
 * Neither can reach the purge:
 *
 *   - A new action it introduces is not in `OPERATIONAL_AUDIT_ACTIONS`,
 *     so it is preserved automatically. No coordination needed, and no
 *     merge conflict in this file.
 *   - Adding an action to `FINANCIAL_AUDIT_ACTIONS` or
 *     `SECURITY_AUDIT_ACTIONS` is *cosmetic* — it improves the label
 *     the compliance UI shows and changes nothing about what is
 *     deleted, because preservation is already the default. Only
 *     editing `OPERATIONAL_AUDIT_ACTIONS` can widen the purge, and that
 *     list is small enough to review by eye.
 *   - Nothing here reads a column list, so new columns are invisible to
 *     it. The single column predicate below (`impersonatedById`) is on
 *     a column that already exists today.
 *
 * In short: the other branch cannot accidentally make a row purgeable.
 */

/**
 * What kind of record an audit row is, derived from its action.
 *
 * Only `OPERATIONAL` is disposable. The other four are all preserved —
 * they are separate labels rather than one "keep" bucket because the
 * compliance UI and the purge audit payload both want to say *why* a
 * row was kept, and "we never classified it" is a different answer from
 * "it evidences a financial decision".
 */
export type AuditRetentionClass =
  "FINANCIAL" | "SECURITY" | "PRIVACY" | "OPERATIONAL" | "UNCLASSIFIED";

/**
 * Money moved, or a decision that commits money was recorded.
 *
 * AMLA §9 / BSP Circular 706 put a five-year floor under these. The
 * list is descriptive, not load-bearing: an action missing from here
 * is preserved anyway as `UNCLASSIFIED`.
 */
export const FINANCIAL_AUDIT_ACTIONS: readonly string[] = [
  "AUTO_APPROVE",
  "AUTO_REJECT",
  "BANK_STATEMENT_AUTO_MATCH",
  "BANK_STATEMENT_IMPORT",
  "ECL_RUN",
  "JOURNAL_REVERSE",
  "JOURNAL_REVERSE_BULK",
  "LEASE_BUYOUT",
  "LOAN_APPROVAL_CHAIN_UPDATE",
  "LOAN_APPROVAL_REJECT",
  "LOAN_APPROVAL_STEP",
  "LOAN_RENEW",
  "LOAN_RESTRUCTURE",
  "LOAN_WRITE_OFF",
  "PENALTY_WAIVE",
];

/**
 * Privileged access, authentication state, and impersonation.
 *
 * §56 names these as sensitive actions that must be audited; an audit
 * that expires before the incident is investigated is not an audit.
 */
export const SECURITY_AUDIT_ACTIONS: readonly string[] = [
  "DELEGATION_CREATE",
  "DELEGATION_EXTEND",
  "DELEGATION_REVOKE",
  "PERMISSION_STATUS_CHANGE",
  "PLATFORM_IMPERSONATION_STARTED",
  "PLATFORM_TENANT_IMPERSONATE",
  "REFRESH_TOKEN_REUSE_DETECTED",
  "ROLE_CREATE",
  "ROLE_DELETE",
  "ROLE_UPDATE",
  "SESSIONS_REVOKED",
  "TOTP_DISABLED",
  "TOTP_ENABLED",
  "TOTP_RECOVERY_USED",
  "USER_ROLE_ASSIGN",
  "USER_ROLE_UNASSIGN",
];

/**
 * Data-subject rights and the settings governing them.
 *
 * A DSAR export row is the evidence that the request was answered, and
 * an erasure row is the evidence that PII was removed on a given date.
 * Deleting either destroys the proof that the Data Privacy Act
 * obligation was met.
 */
export const PRIVACY_AUDIT_ACTIONS: readonly string[] = [
  "CUSTOMER_DATA_EXPORT",
  "CUSTOMER_ERASE",
  "CUSTOMER_DOCUMENTS_PURGE",
  "RETENTION_POLICY_UPDATE",
];

/**
 * THE CLOSED LIST. These, and only these, may be deleted by the
 * retention purge.
 *
 * The bar for adding an entry: the row must record something with no
 * regulatory, financial or security consequence, such that a regulator
 * asking "what happened on this account" would never want it. Read
 * aids and machine-generated reconciliation noise qualify. Anything a
 * borrower could dispute does not.
 *
 * Deliberately NOT here, and the reasoning, because these are the ones
 * a future reader will be tempted by:
 *
 *   - `SEND_REMINDER`, `CALL_BORROWER`, `FIELD_VISIT` and the other
 *     collection-activity rows. They look like noise and they are
 *     high-volume, but they are the contact log a borrower disputes
 *     under fair-collection-practice rules. Whether that log may expire
 *     is a legal question, not an engineering one (§70).
 *   - `CUSTOMER_DATA_EXPORT`. High volume in a DSAR-heavy tenant, but
 *     it is the proof the request was answered.
 */
export const OPERATIONAL_AUDIT_ACTIONS: readonly string[] = [
  // Read aids. The assistant explained or summarised something already
  // recorded elsewhere; the underlying decision has its own row.
  "ASSISTANT_DRAFT_DEMAND_LETTER",
  "ASSISTANT_EXPLAIN_DECISION",
  "ASSISTANT_SUMMARIZE_ACCOUNT",
  // Someone rendered a report. Read-only, changes nothing.
  "REPORT_GENERATED",
  // Machine-generated permission-catalogue reconciliation, one row per
  // boot in some deployments.
  "RBAC_SYNC",
  // The purge's own telemetry. Retaining proof of a purge past the
  // window the purge itself enforces has never been the intent — see
  // the note in retention.service.ts, which predates this file.
  "RETENTION_PURGE",
];

const OPERATIONAL = new Set(OPERATIONAL_AUDIT_ACTIONS);
const FINANCIAL = new Set(FINANCIAL_AUDIT_ACTIONS);
const SECURITY = new Set(SECURITY_AUDIT_ACTIONS);
const PRIVACY = new Set(PRIVACY_AUDIT_ACTIONS);

/**
 * Classify one action label. Unknown actions are `UNCLASSIFIED`, which
 * is a preserved class — see the header for why that default is the
 * safe one.
 */
export function classifyAuditAction(action: string): AuditRetentionClass {
  if (OPERATIONAL.has(action)) return "OPERATIONAL";
  if (FINANCIAL.has(action)) return "FINANCIAL";
  if (SECURITY.has(action)) return "SECURITY";
  if (PRIVACY.has(action)) return "PRIVACY";
  return "UNCLASSIFIED";
}

/**
 * May the retention clock delete a row with this action?
 *
 * Note this ignores impersonation — that is a per-row fact, not a
 * per-action one, and is applied by `purgeableAuditWhere` below.
 */
export function isPurgeableAuditAction(action: string): boolean {
  return classifyAuditAction(action) === "OPERATIONAL";
}

/**
 * The `where` clause for the audit half of the retention purge.
 *
 * Two independent guards, both of which must pass before a row is
 * eligible:
 *
 *   1. `action: { in: [...] }` — the closed operational list. Expressed
 *      as `in` rather than `notIn` precisely because the preserved set
 *      is open-ended: you cannot enumerate the actions that do not
 *      exist yet, but you can enumerate the six that are disposable.
 *
 *   2. `impersonatedById: null` — a row created during a vendor-support
 *      impersonated session is a §56 record of privileged access
 *      regardless of how mundane the action was. Someone rendering a
 *      report *as another user* is exactly the row an investigation
 *      needs, so impersonation overrides the action classification.
 */
export function purgeableAuditWhere(cutoff: Date): {
  createdAt: { lt: Date };
  action: { in: string[] };
  impersonatedById: null;
} {
  return {
    createdAt: { lt: cutoff },
    action: { in: [...OPERATIONAL_AUDIT_ACTIONS] },
    impersonatedById: null,
  };
}

/**
 * The actions the `libs/db` money-path branch named as records that must
 * never come off the general audit clock.
 *
 * This list is NOT what protects them — nothing reads it at runtime except
 * the test that asserts the two halves compose. Protection comes from
 * `OPERATIONAL_AUDIT_ACTIONS` being closed, which preserves these (and
 * everything else unlisted) by default. The list exists so that the claim
 * "none of these is disposable" is checked by CI rather than by eye, and so
 * that adding one of them to the operational list fails a test instead of
 * quietly widening the purge.
 *
 * Every entry classifies as FINANCIAL or UNCLASSIFIED today; both are
 * preserved classes. See audit-retention.test.ts.
 */
export const MONEY_PATH_AUDIT_ACTIONS: readonly string[] = [
  "LOAN_DISBURSE",
  "LOAN_PAYMENT_RECORD",
  "JOURNAL_POST",
  "JOURNAL_REVERSE",
  "ACCOUNTING_PERIOD_CLOSE",
  "ACCOUNTING_PERIOD_REOPEN",
  "KYC_DECIDE",
];

/**
 * The `where` clause for the §71 PII redaction pass — the retention path for
 * audit rows that are NOT allowed to be deleted.
 *
 * ## Why redaction exists at all
 *
 * `ipAddress` and `userAgent` are personal data. §71 says personal data does
 * not get kept forever; §56 says the audit row does. Both are satisfied by
 * nulling those two columns and keeping everything else — the row still
 * evidences that an actor took an action at a time, which is what §56 asks of
 * it, and the two columns that identify a device and a network location are
 * gone. Deleting the row would satisfy §71 by destroying the §56 record, which
 * is not a trade this codebase gets to make.
 *
 * The database enforces the same asymmetry independently: the append-only
 * trigger permits exactly this update (both columns to NULL, nothing else
 * touched) and refuses every other one, so a bug in this predicate cannot turn
 * into a rewritten `action` or a lost row.
 *
 * ## Which rows
 *
 * The exact complement of `purgeableAuditWhere` within the same cutoff, minus
 * rows that have nothing to redact:
 *
 *   1. `createdAt < cutoff` — the same clock. Redaction is not a second,
 *      shorter window, because the point at which the row's provenance stops
 *      being needed is the point at which the row itself would have expired
 *      had it been ordinary. It also means a regulatory hold
 *      (`auditRetentionDays = 0`) freezes redaction too, which is correct:
 *      under a hold, nothing is minimised.
 *
 *   2. `NOT (operational AND non-impersonated)` — i.e. everything the purge
 *      may NOT delete. Written as the explicit negation rather than relying on
 *      the purge having already run, so the two passes are order-independent
 *      and each reads as a complete statement of what it touches.
 *
 *   3. At least one of the two columns is non-null. Skips the rows written
 *      before 20260814140000 added the columns, and every job-driven row that
 *      never had an inbound request — which is most of the table today, and
 *      updating them would be a no-op that still pays the trigger's row check.
 */
export function redactableAuditWhere(cutoff: Date): {
  createdAt: { lt: Date };
  NOT: { action: { in: string[] }; impersonatedById: null };
  OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }];
} {
  return {
    createdAt: { lt: cutoff },
    NOT: {
      action: { in: [...OPERATIONAL_AUDIT_ACTIONS] },
      impersonatedById: null,
    },
    OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
  };
}
