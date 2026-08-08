-- Customer soft delete.
--
-- Hard deletion was never safe here: LoanApplication and CoMaker are
-- RESTRICT, but Contribution and SavingsTransaction CASCADE, so
-- removing a coop member who had saved for years and never borrowed
-- would take every contribution and savings movement with them while
-- the ledger still showed the cash. Archiving keeps the record and the
-- money, and is reversible.
ALTER TABLE "Customer"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archiveReason" TEXT,
  ADD COLUMN "archivedById" TEXT;

-- Partial index: the default customer list filters archivedAt IS NULL
-- on every read, and archived rows are the small minority.
CREATE INDEX "Customer_archivedAt_idx" ON "Customer"("archivedAt");
