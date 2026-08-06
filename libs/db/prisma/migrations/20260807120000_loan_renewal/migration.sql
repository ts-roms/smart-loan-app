-- Loan renewal.
--
-- Distinct from restructure, and the difference is the borrower's
-- standing. A restructure rescues a loan that is going wrong: the terms
-- change because the original ones aren't working. A renewal rewards
-- one that went right — a customer who has paid down enough and is not
-- in arrears takes a fresh loan, and the balance of the old one is
-- settled out of the new proceeds rather than being asked for in cash.

ALTER TABLE "LoanApplication" ADD COLUMN "renewedFromId" TEXT;

-- What the renewal settled, stamped at disbursement. Kept rather than
-- recomputed: the payoff is netted out of the proceeds, so this is the
-- figure the borrower did NOT receive in cash, and reconstructing it
-- later from a schedule since marked paid is guesswork.
ALTER TABLE "LoanApplication" ADD COLUMN "renewalPayoffAmount" DECIMAL(14,2);

-- UNIQUE, not merely indexed. Without it one old balance could be
-- netted off two different new loans and so be paid twice — the lender
-- would hand over less cash on both and the borrower would be charged
-- for the same debt against two schedules. Mirrors the constraint
-- already on restructuredFromId.
CREATE UNIQUE INDEX "LoanApplication_renewedFromId_key"
  ON "LoanApplication"("renewedFromId");

ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_renewedFromId_fkey"
  FOREIGN KEY ("renewedFromId") REFERENCES "LoanApplication"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Eligibility threshold. Configurable because "paid down enough" is a
-- credit-policy judgement rather than a constant: a cooperative lending
-- against salary deductions can afford a lower bar than one lending
-- against a motorcycle.
--
-- 0.5 is the default the operator asked for — half the principal repaid.
ALTER TABLE "SystemConfig"
  ADD COLUMN "renewalMinPaidFraction" DECIMAL(5,4) NOT NULL DEFAULT 0.5;
