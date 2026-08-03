-- Face-match scoring.
-- All four columns are nullable so existing rows survive without
-- backfill; new applications start NULL until an officer runs the
-- match on the loan detail page.

ALTER TABLE "LoanApplication"
  ADD COLUMN "selfieMatchScore"    DOUBLE PRECISION,
  ADD COLUMN "selfieMatchDistance" DOUBLE PRECISION,
  ADD COLUMN "selfieMatchPassed"   BOOLEAN,
  ADD COLUMN "selfieMatchModel"    TEXT,
  ADD COLUMN "selfieMatchedAt"     TIMESTAMP(3);
