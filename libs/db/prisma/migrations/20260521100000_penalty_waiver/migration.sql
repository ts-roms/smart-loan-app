-- Phase A — Penalty Waive facility.
--
-- Adds:
--   * PENALTY_WAIVE value to JournalSource so the reversing entry posted
--     by LoanRepository.waivePenalty is tagged distinctly from MANUAL.
--   * PenaltyWaiver table to snapshot every waive (original vs negotiated
--     amounts, reason, FK to the posted GL reversal).

ALTER TYPE "JournalSource" ADD VALUE 'PENALTY_WAIVE';

CREATE TABLE "PenaltyWaiver" (
  "id"                TEXT NOT NULL,
  "loanId"            TEXT NOT NULL,
  "originalPenalty"   DECIMAL(14, 2) NOT NULL,
  "waivedAmount"      DECIMAL(14, 2) NOT NULL,
  "negotiatedPenalty" DECIMAL(14, 2) NOT NULL,
  "reason"            VARCHAR(500) NOT NULL,
  "journalEntryId"    TEXT,
  "waivedById"        TEXT NOT NULL,
  "waivedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PenaltyWaiver_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PenaltyWaiver_loanId_waivedAt_idx"
  ON "PenaltyWaiver"("loanId", "waivedAt");

ALTER TABLE "PenaltyWaiver"
  ADD CONSTRAINT "PenaltyWaiver_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PenaltyWaiver"
  ADD CONSTRAINT "PenaltyWaiver_waivedById_fkey"
  FOREIGN KEY ("waivedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PenaltyWaiver"
  ADD CONSTRAINT "PenaltyWaiver_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
