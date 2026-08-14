import { AuditLogRepository, type PrismaClient } from "@loan/db";
import type { StorageBackend } from "@loan/storage";

import {
  purgeCustomerDocuments,
  type DocumentPurgeResult,
} from "./document-purge";

/**
 * Compliance service — GDPR / PH Data Privacy Act §16(c) workflows.
 *
 * Two operations live here:
 *
 *   - `exportCustomer(id)` — emit a machine-readable JSON blob of
 *     EVERYTHING the system has on a customer. Designed to satisfy
 *     the "right to data portability" requirement: the borrower (or
 *     a compliance officer acting on their behalf) can hand the file
 *     to a different cooperative or regulator without losing context.
 *
 *   - `eraseCustomer(id, opts)` — overwrite PII fields in the
 *     Customer row with deterministic placeholders, and delete the
 *     uploaded ID photos, payslips and selfies from storage. Financial
 *     records (LoanApplication, JournalEntry, AuditEvent) are
 *     RETAINED — they're regulated records with mandatory retention
 *     periods (typically 5–10 years for AMLA in PH). The Customer
 *     row stays so foreign keys keep resolving, but the human-readable
 *     fields are gone.
 *
 *   - `purgeDocuments(id, opts)` — the file half of erasure on its own,
 *     with a dry-run mode. Runnable against an already-erased customer,
 *     which is how the borrowers erased before this existed get repaired.
 *
 * Both operations write to AuditEvent before returning so the
 * compliance trail captures who exported / erased what, when, and
 * why (the `reason` string is required for erasure — auditors
 * always ask).
 *
 * ## Why not hard-delete?
 *
 * Two reasons:
 *   1. AMLA §9 + BSP Circular 706 require 5 years of customer
 *      records post-relationship-termination. Hard delete = AMLA
 *      violation = bigger problem than a GDPR-erasure request.
 *   2. Foreign keys. LoanApplication.customerId is NOT NULL; deleting
 *      the customer would require cascade-deleting every loan, every
 *      payment, every journal entry — irreversible loss of financial
 *      history.
 *
 * Soft-erasure (overwrite PII in place, keep the row) is the
 * accepted reconciliation: the data subject's PII is gone, the
 * regulated records remain.
 */

const ERASED_PLACEHOLDER = "[ERASED]";

/** Hash-suffixed placeholder for unique-constrained columns. */
function uniqueErased(customerId: string, field: string): string {
  // Short suffix to keep the placeholder readable in audit logs and
  // unique across erasures. customer.id is a UUID; first 8 chars is
  // enough collision resistance for ~4M erased rows per tenant.
  const suffix = customerId.replace(/-/g, "").slice(0, 8);
  return `${ERASED_PLACEHOLDER}-${field}-${suffix}`;
}

export interface ExportArgs {
  customerId: string;
  actorId: string;
  /** Free-form audit note ("subject-access-request #1234"). */
  reason?: string;
}

export interface EraseArgs {
  customerId: string;
  actorId: string;
  /** Required. Auditors always ask why; refuse to run without it. */
  reason: string;
  /** Acknowledgment that the operator understands financial records
   *  are retained. Defaults to false; without `true` the call refuses
   *  to run. UI prompts a confirmation dialog with the explanation. */
  acknowledgesRetention: boolean;
}

export type ExportResult =
  | {
      ok: true;
      generatedAt: string;
      customer: object;
      kycSubmissions: object[];
      loanApplications: object[];
      schedules: object[];
      payments: object[];
      auditEvents: object[];
      contributions: object[];
      savingsTransactions: object[];
      amlScreenings: object[];
      surveyResponses: object[];
      creditScores: object[];
      notifications: object[];
    }
  | { ok: false; kind: "NotFound"; message: string };

export type EraseResult =
  | {
      ok: true;
      customerId: string;
      erasedAt: string;
      fieldsCleared: string[];
      retainedTables: string[];
      /**
       * What happened to the uploaded files, reported rather than
       * promised. This field is the whole point of the change that
       * introduced it: the response used to claim a retention job
       * cleared them, and no such job existed.
       */
      documentsPurged: DocumentPurgeResult;
    }
  | {
      ok: false;
      kind: "NotFound" | "AlreadyErased" | "AcknowledgmentRequired";
      message: string;
    };

export interface PurgeDocumentsArgs {
  customerId: string;
  actorId: string;
  /** Required — same bar as erasure; this deletes bytes irreversibly. */
  reason: string;
  /** Report the plan without deleting anything (§46 dry run). */
  dryRun: boolean;
}

export type PurgeDocumentsResult =
  | ({ ok: true; customerId: string } & DocumentPurgeResult)
  | { ok: false; kind: "NotFound"; message: string };

export class ComplianceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogRepository,
    /**
     * Required, not optional-with-a-default. An erasure that silently
     * skipped storage because nobody passed a backend is the exact
     * failure this service is being fixed for; make it a compile error
     * instead.
     */
    private readonly storage: StorageBackend,
  ) {}

  /**
   * Subject-access export. Returns one JSON object spanning every
   * table that holds data about the customer. The format is
   * intentionally flat-by-table rather than nested — easier for the
   * data subject (or a downstream cooperative) to consume.
   *
   * Errors don't throw; they surface as `{ ok: false, kind }` so the
   * route layer can map them to HTTP cleanly.
   */
  async exportCustomer(args: ExportArgs): Promise<ExportResult> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: args.customerId },
    });
    if (!customer) {
      return {
        ok: false,
        kind: "NotFound",
        message: `Customer ${args.customerId} not found.`,
      };
    }

    // Fan out the related-table reads in parallel. Each individual
    // query is bounded — Customers in PH cooperative space typically
    // have <100 loans, <1000 payments. If a tenant has unusually
    // large customer records, the read cost grows linearly but
    // doesn't fan out across the DB.
    const [
      kycSubmissions,
      loanApplications,
      schedules,
      payments,
      auditEvents,
      contributions,
      savingsTransactions,
      amlScreenings,
      surveyResponses,
      creditScores,
      notifications,
    ] = await Promise.all([
      this.prisma.kycSubmission.findMany({
        where: { customerId: args.customerId },
        orderBy: { submittedAt: "asc" },
      }),
      this.prisma.loanApplication.findMany({
        where: { customerId: args.customerId },
        orderBy: { submittedAt: "asc" },
      }),
      this.prisma.loanSchedule.findMany({
        where: { loan: { customerId: args.customerId } },
        orderBy: { dueDate: "asc" },
      }),
      this.prisma.loanPayment.findMany({
        where: { loan: { customerId: args.customerId } },
        orderBy: { paidOn: "asc" },
      }),
      this.prisma.auditEvent.findMany({
        // Two angles: actions performed BY this customer (their User
        // account) and actions performed ON this customer (targetId).
        // We include both — the data subject is entitled to see what
        // staff has done to their records.
        where: {
          OR: [
            { actorId: args.customerId },
            { targetType: "Customer", targetId: args.customerId },
          ],
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.contribution.findMany({
        where: { customerId: args.customerId },
        orderBy: { contributedAt: "asc" },
      }),
      this.prisma.savingsTransaction.findMany({
        where: { customerId: args.customerId },
        orderBy: { txnDate: "asc" },
      }),
      this.prisma.amlScreening.findMany({
        where: { customerId: args.customerId },
        orderBy: { screenedAt: "asc" },
      }),
      this.prisma.surveyResponse.findMany({
        where: { customerId: args.customerId },
        orderBy: { computedAt: "asc" },
      }),
      this.prisma.creditScore.findMany({
        where: { customerId: args.customerId },
        orderBy: { computedAt: "asc" },
      }),
      this.prisma.notification.findMany({
        where: { customerId: args.customerId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    // Record the export in the audit log BEFORE returning so a
    // concurrent crash doesn't lose the trail. The actor here is the
    // staff member who triggered the export, not the customer.
    await this.audit.record({
      action: "CUSTOMER_DATA_EXPORT",
      actorId: args.actorId,
      targetType: "Customer",
      targetId: args.customerId,
      payload: {
        reason: args.reason ?? null,
        rowCounts: {
          kycSubmissions: kycSubmissions.length,
          loanApplications: loanApplications.length,
          schedules: schedules.length,
          payments: payments.length,
          auditEvents: auditEvents.length,
          contributions: contributions.length,
          savingsTransactions: savingsTransactions.length,
          amlScreenings: amlScreenings.length,
          surveyResponses: surveyResponses.length,
          creditScores: creditScores.length,
          notifications: notifications.length,
        },
      },
    });

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      customer,
      kycSubmissions,
      loanApplications,
      schedules,
      payments,
      auditEvents,
      contributions,
      savingsTransactions,
      amlScreenings,
      surveyResponses,
      creditScores,
      notifications,
    };
  }

  /**
   * Right-to-erasure executor. Overwrites every PII field on the
   * Customer row with deterministic placeholders, then sets
   * `erasedAt` + `erasedById`. The row stays — foreign keys still
   * resolve — but the human-readable PII is gone.
   *
   * Idempotent in the sense that re-running on an already-erased
   * customer returns `AlreadyErased` instead of double-erasing
   * (which would lose the original erasedAt timestamp).
   *
   * Returns the list of fields that were cleared so the audit row
   * captures the exact scope of the redaction. Useful for the
   * compliance team during DSAR reconciliation.
   */
  async eraseCustomer(args: EraseArgs): Promise<EraseResult> {
    if (!args.acknowledgesRetention) {
      return {
        ok: false,
        kind: "AcknowledgmentRequired",
        message:
          "Operator must acknowledge that financial records (loans, payments, journal entries, audit events) are retained per AMLA §9 / BSP Circular 706.",
      };
    }
    const customer = await this.prisma.customer.findUnique({
      where: { id: args.customerId },
    });
    if (!customer) {
      return {
        ok: false,
        kind: "NotFound",
        message: `Customer ${args.customerId} not found.`,
      };
    }
    if (customer.erasedAt) {
      return {
        ok: false,
        kind: "AlreadyErased",
        message: `Customer ${args.customerId} was already erased at ${customer.erasedAt.toISOString()}.`,
      };
    }

    const now = new Date();
    // List the fields we're clearing here (vs in-line in the update
    // call) so the audit payload is the single source of truth on
    // what was redacted. Compliance teams use this list to verify
    // the erasure scope.
    const fieldsCleared = [
      "firstName",
      "middleName",
      "lastName",
      "suffix",
      "phone",
      "secondaryPhone",
      "email",
      "address",
      "addressLine2",
      "barangay",
      "city",
      "province",
      "region",
      "postalCode",
      "spouseName",
      "spouseDateOfBirth",
      "spouseContact",
      "spouseOccupation",
      "governmentIdNumber",
      "employerName",
      "jobTitle",
      "position",
      "hireDate",
      "regularizationDate",
      "yearsAtCurrentJob",
    ];

    await this.prisma.$transaction([
      this.prisma.customer.update({
        where: { id: args.customerId },
        data: {
          firstName: ERASED_PLACEHOLDER,
          middleName: null,
          lastName: ERASED_PLACEHOLDER,
          suffix: null,
          phone: uniqueErased(args.customerId, "phone"),
          secondaryPhone: null,
          // email is nullable — set to null (cleanest).
          email: null,
          address: ERASED_PLACEHOLDER,
          addressLine2: null,
          barangay: null,
          city: ERASED_PLACEHOLDER,
          province: null,
          region: null,
          postalCode: null,
          spouseName: null,
          spouseDateOfBirth: null,
          spouseContact: null,
          spouseOccupation: null,
          // governmentIdNumber has a composite index but no unique
          // constraint — placeholder is safe.
          governmentIdNumber: uniqueErased(args.customerId, "gov-id"),
          employerName: null,
          jobTitle: null,
          position: null,
          hireDate: null,
          regularizationDate: null,
          yearsAtCurrentJob: null,
          // NOT cleared: dateOfBirth, monthlyIncome — these are needed
          // for retained financial records (income for loan decision
          // history, DOB for AMLA-required retention metadata). The
          // privacy benefit of clearing them doesn't outweigh the
          // financial-record integrity loss.
          erasedAt: now,
          erasedById: args.actorId,
        },
      }),
      // Disable the customer's portal login if they had one. The User
      // row stays for audit history; the active flag goes false so
      // they can't log in with the (still-stored) password hash.
      this.prisma.user.updateMany({
        where: { customerId: args.customerId },
        data: { active: false },
      }),
    ]);

    // Delete the uploaded files. AFTER the column redaction, because
    // the redaction is the legally required half and must not be held
    // up by a storage outage; the file purge is re-runnable on its own
    // if this leg degrades, and reports honestly when it does.
    const documentsPurged = await purgeCustomerDocuments({
      prisma: this.prisma,
      storage: this.storage,
      customerId: args.customerId,
      dryRun: false,
    });

    // Audit AFTER the redaction lands. Records the metadata about
    // the erasure (who, why, what fields) — but obviously NOT a
    // before-snapshot of the cleared values, since that would be
    // a backdoor undo.
    await this.audit.record({
      action: "CUSTOMER_ERASE",
      actorId: args.actorId,
      targetType: "Customer",
      targetId: args.customerId,
      payload: {
        reason: args.reason,
        fieldsCleared,
        erasedAt: now.toISOString(),
        documentsPurged,
        retentionNote:
          "Financial records (LoanApplication, LoanSchedule, LoanPayment, JournalEntry, AuditEvent) are retained per AMLA §9.",
      },
    });

    return {
      ok: true,
      customerId: args.customerId,
      erasedAt: now.toISOString(),
      fieldsCleared,
      documentsPurged,
      retainedTables: [
        "LoanApplication",
        "LoanSchedule",
        "LoanPayment",
        "JournalEntry",
        "JournalLine",
        "AuditEvent",
        "Contribution",
        "SavingsTransaction",
        "AmlScreening",
        // The header row is the compliance record — it evidences that
        // identity verification happened, who decided it and when, and
        // AMLA §9 retention applies to it exactly as to a journal entry.
        // The uploaded document behind it is raw PII and was deleted;
        // `documentsPurged` carries the per-file outcome. This entry
        // says "header rows" and stops there on purpose: it used to
        // promise that a retention job cleared the files, and no such
        // job existed.
        "KycSubmission (header rows only — the verification decision; the uploaded document itself was deleted, see documentsPurged)",
      ],
    };
  }

  /**
   * The file half of erasure, on its own, with a dry run.
   *
   * Exists separately from `eraseCustomer` for two reasons:
   *
   *   1. §46 requires a migration-safety shape — Backup → Dry Run →
   *      Validation → Migration → Reconciliation → Audit. `dryRun: true`
   *      is the second step: it reports exactly which objects a real run
   *      would remove, without removing any, so an operator can validate
   *      the plan before the irreversible part.
   *   2. `eraseCustomer` refuses to run on an already-erased customer,
   *      but the customers who most need their files removed are exactly
   *      the ones erased BEFORE this purge existed. This entry point is
   *      not gated on `erasedAt`, so it can repair them.
   *
   * Safe to re-run. A row whose pointer column is already cleared is not
   * a candidate, and a row pointing at an object storage no longer holds
   * resolves as `ALREADY_ABSENT` rather than an error.
   */
  async purgeDocuments(
    args: PurgeDocumentsArgs,
  ): Promise<PurgeDocumentsResult> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: args.customerId },
      select: { id: true },
    });
    if (!customer) {
      return {
        ok: false,
        kind: "NotFound",
        message: `Customer ${args.customerId} not found.`,
      };
    }

    const result = await purgeCustomerDocuments({
      prisma: this.prisma,
      storage: this.storage,
      customerId: args.customerId,
      dryRun: args.dryRun,
    });

    // Audit both modes. A dry run is still a read of which documents a
    // customer holds, and §46's reconciliation step wants the plan and
    // the eventual outcome to be comparable after the fact.
    await this.audit.record({
      action: "CUSTOMER_DOCUMENTS_PURGE",
      actorId: args.actorId,
      targetType: "Customer",
      targetId: args.customerId,
      payload: { reason: args.reason, ...result },
    });

    return { ok: true, customerId: args.customerId, ...result };
  }
}
