-- CreateEnum
CREATE TYPE "LoanMessageAuthor" AS ENUM ('OFFICER', 'BORROWER');

-- CreateEnum
CREATE TYPE "EclStage" AS ENUM ('STAGE_1', 'STAGE_2', 'STAGE_3');

-- CreateEnum
CREATE TYPE "BankStatementStatus" AS ENUM ('IMPORTED', 'RECONCILED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "eclComputedAt" TIMESTAMP(3),
ADD COLUMN     "eclProvision" DECIMAL(18,2),
ADD COLUMN     "eclStage" "EclStage" NOT NULL DEFAULT 'STAGE_1';

-- AlterTable
ALTER TABLE "LoanProduct" ADD COLUMN     "eclLgd" DECIMAL(6,4) NOT NULL DEFAULT 0.45,
ADD COLUMN     "eclPd12m" DECIMAL(6,4) NOT NULL DEFAULT 0.05,
ADD COLUMN     "eclPdLifetime" DECIMAL(6,4) NOT NULL DEFAULT 0.20;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastSeenNotificationAt" TIMESTAMP(3),
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totpSecret" TEXT;

-- CreateTable
CREATE TABLE "LoanMessage" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" "LoanMessageAuthor" NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EclRun" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalEad" DECIMAL(18,2) NOT NULL,
    "totalEcl" DECIMAL(18,2) NOT NULL,
    "stage1Count" INTEGER NOT NULL,
    "stage2Count" INTEGER NOT NULL,
    "stage3Count" INTEGER NOT NULL,
    "stage1Ecl" DECIMAL(18,2) NOT NULL,
    "stage2Ecl" DECIMAL(18,2) NOT NULL,
    "stage3Ecl" DECIMAL(18,2) NOT NULL,
    "journalEntryId" TEXT,
    "computedById" TEXT,
    "notes" TEXT,

    CONSTRAINT "EclRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "bankAccount" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "openingBalance" DECIMAL(18,2) NOT NULL,
    "closingBalance" DECIMAL(18,2) NOT NULL,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "BankStatementStatus" NOT NULL DEFAULT 'IMPORTED',

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "runningBalance" DECIMAL(18,2),
    "matchedType" TEXT,
    "matchedRefId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedById" TEXT,
    "matchNote" TEXT,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoanMessage_loanId_createdAt_idx" ON "LoanMessage"("loanId", "createdAt");

-- CreateIndex
CREATE INDEX "LoanMessage_readAt_idx" ON "LoanMessage"("readAt");

-- CreateIndex
CREATE INDEX "EclRun_periodEnd_idx" ON "EclRun"("periodEnd");

-- CreateIndex
CREATE INDEX "BankStatement_periodStart_periodEnd_idx" ON "BankStatement"("periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "BankStatement_status_idx" ON "BankStatement"("status");

-- CreateIndex
CREATE INDEX "BankStatementLine_statementId_idx" ON "BankStatementLine"("statementId");

-- CreateIndex
CREATE INDEX "BankStatementLine_txnDate_idx" ON "BankStatementLine"("txnDate");

-- CreateIndex
CREATE INDEX "BankStatementLine_matchedAt_idx" ON "BankStatementLine"("matchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "LoanMessage" ADD CONSTRAINT "LoanMessage_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
