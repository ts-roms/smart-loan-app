-- ───────────────────────────────────────────────────────────────────────
-- Make loan products dynamic: drop the LoanType enum, replace the column
-- on LoanProduct (type → code) and LoanApplication (type → productCode),
-- and add a real FK from applications to the product catalog.
--
-- This migration preserves existing values by casting the enum to TEXT
-- before dropping the column.
-- ───────────────────────────────────────────────────────────────────────

-- New supporting enums.
CREATE TYPE "InterestMethod" AS ENUM ('DECLINING', 'FLAT');
CREATE TYPE "PaymentFrequency" AS ENUM ('MONTHLY', 'BIWEEKLY', 'WEEKLY');

-- ── LoanProduct.type → LoanProduct.code ───────────────────────────────
DROP INDEX IF EXISTS "LoanProduct_type_key";

ALTER TABLE "LoanProduct" ADD COLUMN "code" TEXT;
UPDATE "LoanProduct" SET "code" = "type"::text;
ALTER TABLE "LoanProduct" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "LoanProduct_code_key" ON "LoanProduct"("code");

-- ── LoanApplication.type → LoanApplication.productCode ──────────────
DROP INDEX IF EXISTS "LoanApplication_type_idx";

ALTER TABLE "LoanApplication" ADD COLUMN "productCode" TEXT;
UPDATE "LoanApplication" SET "productCode" = "type"::text;
ALTER TABLE "LoanApplication"
  ALTER COLUMN "productCode" SET NOT NULL,
  ALTER COLUMN "productCode" SET DEFAULT 'SALARY';
CREATE INDEX "LoanApplication_productCode_idx" ON "LoanApplication"("productCode");

-- Drop old enum-typed columns.
ALTER TABLE "LoanApplication" DROP COLUMN "type";
ALTER TABLE "LoanProduct"     DROP COLUMN "type";

-- Drop the now-unused enum.
DROP TYPE "LoanType";

-- ── New columns on LoanProduct (fees, late-fee policy, methods, tiers) ──
ALTER TABLE "LoanProduct"
  ADD COLUMN "processingFeeRate"      DECIMAL(5,4)  NOT NULL DEFAULT 0,
  ADD COLUMN "processingFeeFlat"      DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "documentaryStampRate"   DECIMAL(5,4)  NOT NULL DEFAULT 0,
  ADD COLUMN "lateFeeDailyRate"       DECIMAL(5,4)  NOT NULL DEFAULT 0.01,
  ADD COLUMN "lateFeeCapFraction"     DECIMAL(5,4)  NOT NULL DEFAULT 0.1,
  ADD COLUMN "lateFeeGraceDays"       INTEGER       NOT NULL DEFAULT 3,
  ADD COLUMN "preTerminationFeeRate"  DECIMAL(5,4)  NOT NULL DEFAULT 0,
  ADD COLUMN "interestMethod"         "InterestMethod"   NOT NULL DEFAULT 'DECLINING',
  ADD COLUMN "paymentFrequency"       "PaymentFrequency" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN "rateByTier"             JSONB,
  ADD COLUMN "ltvByTier"              JSONB;

-- FK from applications to the product catalog.
ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_productCode_fkey"
  FOREIGN KEY ("productCode") REFERENCES "LoanProduct"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;
