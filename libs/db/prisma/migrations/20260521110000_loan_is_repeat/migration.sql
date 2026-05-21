-- FRD Phase A — Repeat-loan detection.
--
-- Sets `isRepeat=true` on new applications whose customer already has a
-- fully-paid prior loan, surfaced as a badge on the application form +
-- loan detail. Defaults to false; the apply() method backfills based on
-- the customer's loan history at submission time.

ALTER TABLE "LoanApplication"
  ADD COLUMN "isRepeat" BOOLEAN NOT NULL DEFAULT false;
