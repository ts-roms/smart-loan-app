-- CreateEnum
CREATE TYPE "CoMakerRole" AS ENUM ('CO_BORROWER', 'GUARANTOR', 'CO_MAKER');

-- CreateEnum
CREATE TYPE "RuleAction" AS ENUM ('AUTO_APPROVE', 'AUTO_REJECT', 'MANUAL_REVIEW');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LoanStatus" ADD VALUE 'RESTRUCTURED';
ALTER TYPE "LoanStatus" ADD VALUE 'WRITTEN_OFF';

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "restructuredFromId" TEXT,
ADD COLUMN     "writeOffAmount" DECIMAL(14,2),
ADD COLUMN     "writeOffReason" TEXT,
ADD COLUMN     "writtenOffAt" TIMESTAMP(3),
ADD COLUMN     "writtenOffById" TEXT;

-- CreateTable
CREATE TABLE "CoMaker" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "role" "CoMakerRole" NOT NULL DEFAULT 'CO_MAKER',
    "relationship" TEXT,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT,
    "governmentIdType" "GovernmentIdType",
    "governmentIdNumber" TEXT,
    "monthlyIncome" DECIMAL(14,2),
    "signedAgreementUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoMaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 500,
    "conditions" JSONB NOT NULL,
    "action" "RuleAction" NOT NULL,
    "reason" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DecisionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoMaker_loanId_idx" ON "CoMaker"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRule_name_key" ON "DecisionRule"("name");

-- CreateIndex
CREATE INDEX "DecisionRule_priority_active_idx" ON "DecisionRule"("priority", "active");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_restructuredFromId_key" ON "LoanApplication"("restructuredFromId");

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_restructuredFromId_fkey" FOREIGN KEY ("restructuredFromId") REFERENCES "LoanApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoMaker" ADD CONSTRAINT "CoMaker_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

