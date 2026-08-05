-- Co-maker consent.
--
-- A co-maker is jointly liable, so agreeing to it is their decision
-- rather than a box the officer ticks. Existing rows are backfilled to
-- APPROVED, not PENDING: they were entered under the old model where
-- adding a co-maker implied their agreement, and defaulting them to
-- PENDING would block disbursement on every loan already in flight.

CREATE TYPE "CoMakerConsentStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

ALTER TABLE "CoMaker"
  ADD COLUMN "status" "CoMakerConsentStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "respondedAt" TIMESTAMP(3),
  ADD COLUMN "declineReason" TEXT,
  ADD COLUMN "inviteToken" TEXT,
  ADD COLUMN "inviteSentAt" TIMESTAMP(3),
  ADD COLUMN "inviteExpiresAt" TIMESTAMP(3);

-- Grandfather what's already on file. See above.
UPDATE "CoMaker" SET "status" = 'APPROVED', "respondedAt" = "createdAt";

CREATE UNIQUE INDEX "CoMaker_inviteToken_key" ON "CoMaker"("inviteToken");

CREATE TABLE "CoMakerDocument" (
  "id"           TEXT NOT NULL,
  "coMakerId"    TEXT NOT NULL,
  "documentType" "KycDocumentType" NOT NULL,
  "documentUrl"  TEXT NOT NULL,
  "notes"        TEXT,
  "uploadedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CoMakerDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CoMakerDocument_coMakerId_idx" ON "CoMakerDocument"("coMakerId");

ALTER TABLE "CoMakerDocument"
  ADD CONSTRAINT "CoMakerDocument_coMakerId_fkey"
  FOREIGN KEY ("coMakerId") REFERENCES "CoMaker"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
