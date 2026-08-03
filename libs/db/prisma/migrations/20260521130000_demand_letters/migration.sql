- Phase B — Demand Letter module.
--
-- Adds:
--   * DemandLetter table with stage + status enums.
--   * DEMAND_LETTER_DISPATCHED notification event.
--
-- Stage = FIRST / FINAL / ATTORNEY_FIRST / ATTORNEY_FINAL.
-- Status = DRAFTED -> DISPATCHED -> RESPONDED (or WAIVED to close).

ALTER TYPE "NotificationEvent" ADD VALUE 'DEMAND_LETTER_DISPATCHED';

CREATE TYPE "DemandLetterStage" AS ENUM (
  'FIRST',
  'FINAL',
  'ATTORNEY_FIRST',
  'ATTORNEY_FINAL'
);

CREATE TYPE "DemandLetterStatus" AS ENUM (
  'DRAFTED',
  'DISPATCHED',
  'RESPONDED',
  'WAIVED'
);

CREATE TABLE "DemandLetter" (
  "id"              TEXT NOT NULL,
  "loanId"          TEXT NOT NULL,
  "stage"           "DemandLetterStage" NOT NULL,
  "status"          "DemandLetterStatus" NOT NULL DEFAULT 'DRAFTED',
  "principalOwed"   DECIMAL(14, 2) NOT NULL,
  "interestOwed"    DECIMAL(14, 2) NOT NULL,
  "penaltiesOwed"   DECIMAL(14, 2) NOT NULL,
  "totalOwed"       DECIMAL(14, 2) NOT NULL,
  "daysOverdue"     INTEGER NOT NULL,
  "paymentDeadline" TIMESTAMP(3) NOT NULL,
  "body"            TEXT NOT NULL,
  "draftedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "draftedById"     TEXT NOT NULL,
  "dispatchedAt"    TIMESTAMP(3),
  "dispatchedById"  TEXT,
  "dispatchChannel" TEXT,
  "dispatchRef"     TEXT,
  "closedAt"        TIMESTAMP(3),
  "closedById"      TEXT,
  "closedReason"    VARCHAR(500),

  CONSTRAINT "DemandLetter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DemandLetter_loanId_status_idx"
  ON "DemandLetter"("loanId", "status");

CREATE INDEX "DemandLetter_stage_status_idx"
  ON "DemandLetter"("stage", "status");

CREATE INDEX "DemandLetter_draftedAt_idx"
  ON "DemandLetter"("draftedAt" DESC);

ALTER TABLE "DemandLetter"
  ADD CONSTRAINT "DemandLetter_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DemandLetter"
  ADD CONSTRAINT "DemandLetter_draftedById_fkey"
  FOREIGN KEY ("draftedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DemandLetter"
  ADD CONSTRAINT "DemandLetter_dispatchedById_fkey"
  FOREIGN KEY ("dispatchedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DemandLetter"
  ADD CONSTRAINT "DemandLetter_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
