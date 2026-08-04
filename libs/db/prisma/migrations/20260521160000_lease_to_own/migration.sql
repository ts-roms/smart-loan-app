-- Phase E — Lease-to-Own product.
--
-- Adds:
--   * Lease-specific fields on LoanProduct (isLease, residualValueFraction,
--     employeeOnly, missedPaymentPullOutCount, maintenanceReminderMonths).
--   * LEASE_BUYOUT JournalSource for the residual settlement entry.
--   * 3 new NotificationEvent values for end-of-term / maintenance /
--     pull-out warning.
--   * LeaseStatus + LeaseTitleHolder enums.
--   * LeaseAgreement table — one row per loan when product.isLease is true.

ALTER TYPE "JournalSource" ADD VALUE 'LEASE_BUYOUT';
ALTER TYPE "NotificationEvent" ADD VALUE 'LEASE_END_OF_TERM';
ALTER TYPE "NotificationEvent" ADD VALUE 'LEASE_MAINTENANCE_REMINDER';
ALTER TYPE "NotificationEvent" ADD VALUE 'LEASE_PULL_OUT_WARNING';

CREATE TYPE "LeaseStatus" AS ENUM (
  'ACTIVE',
  'PULLED_OUT',
  'BUYOUT_COMPLETED',
  'RETURNED',
  'EXTENDED'
);

CREATE TYPE "LeaseTitleHolder" AS ENUM ('COMPANY', 'CUSTOMER');

ALTER TABLE "LoanProduct"
  ADD COLUMN "isLease" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "residualValueFraction" DECIMAL(5, 4),
  ADD COLUMN "employeeOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "missedPaymentPullOutCount" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "maintenanceReminderMonths" INTEGER NOT NULL DEFAULT 6;

CREATE TABLE "LeaseAgreement" (
  "id"                       TEXT NOT NULL,
  "loanId"                   TEXT NOT NULL,
  "status"                   "LeaseStatus" NOT NULL DEFAULT 'ACTIVE',
  "residualValue"            DECIMAL(14, 2) NOT NULL,
  "titleHolder"              "LeaseTitleHolder" NOT NULL DEFAULT 'COMPANY',
  "isEmployee"               BOOLEAN NOT NULL,
  "missedPaymentStreak"      INTEGER NOT NULL DEFAULT 0,
  "lastPullOutWarningAt"     TIMESTAMP(3),
  "endOfTermNoticeSentAt"    TIMESTAMP(3),
  "lastMaintenanceReminderAt" TIMESTAMP(3),
  "buyoutPaidAmount"         DECIMAL(14, 2),
  "buyoutAt"                 TIMESTAMP(3),
  "buyoutById"               TEXT,
  "buyoutJournalEntryId"     TEXT,
  "pulledOutAt"              TIMESTAMP(3),
  "pulledOutById"            TEXT,
  "pullOutReason"            VARCHAR(500),
  "closedAt"                 TIMESTAMP(3),
  "closedReason"             VARCHAR(500),
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LeaseAgreement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaseAgreement_loanId_key" ON "LeaseAgreement"("loanId");
CREATE INDEX "LeaseAgreement_status_idx" ON "LeaseAgreement"("status");

ALTER TABLE "LeaseAgreement" ADD CONSTRAINT "LeaseAgreement_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaseAgreement" ADD CONSTRAINT "LeaseAgreement_buyoutById_fkey"
  FOREIGN KEY ("buyoutById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeaseAgreement" ADD CONSTRAINT "LeaseAgreement_pulledOutById_fkey"
  FOREIGN KEY ("pulledOutById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeaseAgreement" ADD CONSTRAINT "LeaseAgreement_buyoutJournalEntryId_fkey"
  FOREIGN KEY ("buyoutJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
