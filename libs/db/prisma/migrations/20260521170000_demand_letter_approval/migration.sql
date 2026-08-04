-- G3 — Demand Letter escalation matrix.
--
-- Adds an APPROVED status between DRAFTED and DISPATCHED, plus three
-- nullable approval-snapshot fields. The escalation chain (Credit
-- Officer drafts → Operations Manager approves for company variants;
-- Lawyer approves for attorney variants) is enforced at the API layer
-- via two new permissions; the row just captures who approved when.

ALTER TYPE "DemandLetterStatus" ADD VALUE 'APPROVED' BEFORE 'DISPATCHED';

ALTER TABLE "DemandLetter"
  ADD COLUMN "approvedAt"   TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvalNote" VARCHAR(500);

ALTER TABLE "DemandLetter"
  ADD CONSTRAINT "DemandLetter_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
