-- FRD §3.8 Phase B — Annual Documentation tracker.
--
-- Tracks renewable docs (car insurance, RPT, OR/CR, fire insurance) with
-- expiry-aware status + reminder bookkeeping. Daily job scans for rows with
-- expiresAt within 30 days and enqueues notifications.

ALTER TYPE "NotificationEvent" ADD VALUE 'ANNUAL_DOC_EXPIRING';
ALTER TYPE "NotificationEvent" ADD VALUE 'ANNUAL_DOC_EXPIRED';

CREATE TYPE "AnnualDocumentType" AS ENUM (
  'CAR_INSURANCE',
  'OR_CR',
  'RPT',
  'FIRE_INSURANCE',
  'OTHER'
);

CREATE TYPE "AnnualDocumentStatus" AS ENUM (
  'VALID',
  'EXPIRING_SOON',
  'EXPIRED'
);

CREATE TABLE "AnnualDocument" (
  "id"             TEXT NOT NULL,
  "loanId"         TEXT NOT NULL,
  "type"           "AnnualDocumentType" NOT NULL,
  "name"           VARCHAR(200) NOT NULL,
  "documentUrl"    TEXT,
  "effectiveFrom"  TIMESTAMP(3) NOT NULL,
  "expiresAt"      TIMESTAMP(3) NOT NULL,
  "status"         "AnnualDocumentStatus" NOT NULL DEFAULT 'VALID',
  "notes"          TEXT,
  "submittedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedById"  TEXT NOT NULL,
  "lastReminderAt" TIMESTAMP(3),
  "reminderCount"  INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "AnnualDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnnualDocument_loanId_expiresAt_idx"
  ON "AnnualDocument"("loanId", "expiresAt");

CREATE INDEX "AnnualDocument_expiresAt_idx"
  ON "AnnualDocument"("expiresAt");

CREATE INDEX "AnnualDocument_status_idx"
  ON "AnnualDocument"("status");

ALTER TABLE "AnnualDocument"
  ADD CONSTRAINT "AnnualDocument_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnnualDocument"
  ADD CONSTRAINT "AnnualDocument_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
