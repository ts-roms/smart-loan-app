-- FRD §3.7 Phase C — Repossession workflow.
--
-- Adds:
--   * REPOSSESSION_AUCTION value to JournalSource so the auction
--     settlement entry is distinct from MANUAL.
--   * RepossessionStatus enum (full state machine).
--   * RepossessionCase table — one active case per loan (unique loanId),
--     with the full BM → Credit Head → Legal approval chain captured
--     plus agent assignment, recovery, and auction settlement fields.

ALTER TYPE "JournalSource" ADD VALUE 'REPOSSESSION_AUCTION';

CREATE TYPE "RepossessionStatus" AS ENUM (
  'IDENTIFIED',
  'BM_APPROVED',
  'CREDIT_HEAD_APPROVED',
  'LEGAL_APPROVED',
  'AGENT_ASSIGNED',
  'RECOVERED',
  'AUCTIONED',
  'CLOSED',
  'CANCELLED'
);

CREATE TABLE "RepossessionCase" (
  "id"                       TEXT NOT NULL,
  "loanId"                   TEXT NOT NULL,
  "status"                   "RepossessionStatus" NOT NULL DEFAULT 'IDENTIFIED',
  "reason"                   VARCHAR(500) NOT NULL,
  "identifiedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "identifiedById"           TEXT NOT NULL,

  "bmApprovedAt"             TIMESTAMP(3),
  "bmApprovedById"           TEXT,
  "bmApprovalNote"           TEXT,
  "creditHeadApprovedAt"     TIMESTAMP(3),
  "creditHeadApprovedById"   TEXT,
  "creditHeadApprovalNote"   TEXT,
  "legalApprovedAt"          TIMESTAMP(3),
  "legalApprovedById"        TEXT,
  "legalApprovalNote"        TEXT,

  "agentName"                TEXT,
  "agentContact"             TEXT,
  "agentAssignedAt"          TIMESTAMP(3),
  "agentAssignedById"        TEXT,

  "recoveredAt"              TIMESTAMP(3),
  "recoveredById"            TEXT,
  "vehicleCondition"         VARCHAR(500),
  "vehicleMileage"           INTEGER,
  "vehiclePhotos"            TEXT,
  "storageLocation"          TEXT,

  "auctionedAt"              TIMESTAMP(3),
  "auctionedById"            TEXT,
  "auctionMethod"            TEXT,
  "auctionProceeds"          DECIMAL(14, 2),
  "outstandingAtRecovery"    DECIMAL(14, 2),
  "deficiency"               DECIMAL(14, 2),
  "journalEntryId"           TEXT,

  "cancelledAt"              TIMESTAMP(3),
  "cancelledById"            TEXT,
  "cancellationReason"       VARCHAR(500),

  CONSTRAINT "RepossessionCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RepossessionCase_loanId_key" ON "RepossessionCase"("loanId");
CREATE INDEX "RepossessionCase_status_idx" ON "RepossessionCase"("status");
CREATE INDEX "RepossessionCase_identifiedAt_idx" ON "RepossessionCase"("identifiedAt" DESC);

ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_identifiedById_fkey"
  FOREIGN KEY ("identifiedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_bmApprovedById_fkey"
  FOREIGN KEY ("bmApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_creditHeadApprovedById_fkey"
  FOREIGN KEY ("creditHeadApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_legalApprovedById_fkey"
  FOREIGN KEY ("legalApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_agentAssignedById_fkey"
  FOREIGN KEY ("agentAssignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_recoveredById_fkey"
  FOREIGN KEY ("recoveredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_auctionedById_fkey"
  FOREIGN KEY ("auctionedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RepossessionCase" ADD CONSTRAINT "RepossessionCase_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
