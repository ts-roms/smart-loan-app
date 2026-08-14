/**
 * Compliance feature — GDPR / PH Data Privacy Act §16(c) (right to
 * access) + §16(e) (right to erasure / blocking) workflows, plus the
 * data-retention policy + nightly purge job.
 *
 * Layered: routes → controller → services. Two services:
 *   - `ComplianceService` for DSAR export + erase
 *   - `RetentionService` for the policy + purge
 *
 * The retention purge is also invoked from a scheduled job (see
 * apps/api/src/jobs.ts → `data-retention-purge`), so the service is
 * exported for the job-definitions module to reuse.
 *
 * @see docs/runbooks.md R7 (DSAR procedure)
 */

export { complianceRoutes } from "./compliance.routes";
export {
  ComplianceService,
  type ExportArgs,
  type ExportResult,
  type EraseArgs,
  type EraseResult,
  type PurgeDocumentsArgs,
  type PurgeDocumentsResult,
} from "./compliance.service";
export {
  DOCUMENT_TOMBSTONE,
  purgeCustomerDocuments,
  type DocumentPurgeItem,
  type DocumentPurgeOutcome,
  type DocumentPurgeResult,
} from "./document-purge";
export {
  RetentionService,
  AMLA_AUDIT_FLOOR_DAYS,
  type RetentionPolicyView,
  type RetentionPurgeResult,
  type UpdateRetentionInput,
  type UpdateRetentionResult,
} from "./retention.service";
export {
  classifyAuditAction,
  isPurgeableAuditAction,
  purgeableAuditWhere,
  FINANCIAL_AUDIT_ACTIONS,
  OPERATIONAL_AUDIT_ACTIONS,
  PRIVACY_AUDIT_ACTIONS,
  SECURITY_AUDIT_ACTIONS,
  type AuditRetentionClass,
} from "./audit-retention";
