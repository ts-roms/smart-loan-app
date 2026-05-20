-- CreateEnum
CREATE TYPE "SavingsTxnKind" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- AlterEnum (Postgres 12+ supports multi-value ADD in a single migration)
ALTER TYPE "JournalSource" ADD VALUE 'COOP_CONTRIBUTION';
ALTER TYPE "JournalSource" ADD VALUE 'COOP_SAVINGS';
ALTER TYPE "JournalSource" ADD VALUE 'COOP_FUND_IN';
ALTER TYPE "JournalSource" ADD VALUE 'COOP_FUND_OUT';
ALTER TYPE "JournalSource" ADD VALUE 'COOP_EXPENSE';
ALTER TYPE "JournalSource" ADD VALUE 'COOP_OTHER_INCOME';
ALTER TYPE "JournalSource" ADD VALUE 'COOP_BIG_BROTHER';

-- CreateTable
CREATE TABLE "Contribution" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "capitalBuildUp" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "mortuaryFund" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "emergencyFund" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "contributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "Contribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsTransaction" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "kind" "SavingsTxnKind" NOT NULL DEFAULT 'DEPOSIT',
    "amount" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "txnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "SavingsTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundTransaction" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "transactionRef" TEXT,
    "sourceOfFunds" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorId" TEXT,
    "notes" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "FundTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundWithdrawal" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "sourceOfFunds" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "txnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorId" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "FundWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sourceOfFunds" TEXT NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "attachments" TEXT[],
    "notes" TEXT,
    "recordedById" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtherIncome" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "sourceTo" TEXT NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachments" TEXT[],
    "notes" TEXT,
    "recordedById" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "OtherIncome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BigBrotherAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "capital" DECIMAL(18,2) NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "BigBrotherAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contribution_customerId_contributedAt_idx" ON "Contribution"("customerId", "contributedAt");
CREATE INDEX "Contribution_contributedAt_idx" ON "Contribution"("contributedAt");
CREATE INDEX "SavingsTransaction_customerId_txnDate_idx" ON "SavingsTransaction"("customerId", "txnDate");
CREATE INDEX "SavingsTransaction_txnDate_idx" ON "SavingsTransaction"("txnDate");
CREATE INDEX "FundTransaction_sourceOfFunds_txnDate_idx" ON "FundTransaction"("sourceOfFunds", "txnDate");
CREATE INDEX "FundTransaction_customerId_idx" ON "FundTransaction"("customerId");
CREATE INDEX "FundWithdrawal_sourceOfFunds_txnDate_idx" ON "FundWithdrawal"("sourceOfFunds", "txnDate");
CREATE INDEX "FundWithdrawal_customerId_idx" ON "FundWithdrawal"("customerId");
CREATE INDEX "Expense_type_txnDate_idx" ON "Expense"("type", "txnDate");
CREATE INDEX "Expense_txnDate_idx" ON "Expense"("txnDate");
CREATE INDEX "OtherIncome_type_txnDate_idx" ON "OtherIncome"("type", "txnDate");
CREATE INDEX "OtherIncome_txnDate_idx" ON "OtherIncome"("txnDate");
CREATE INDEX "BigBrotherAccount_active_idx" ON "BigBrotherAccount"("active");
CREATE INDEX "BigBrotherAccount_periodFrom_periodTo_idx" ON "BigBrotherAccount"("periodFrom", "periodTo");

-- AddForeignKey
ALTER TABLE "Contribution" ADD CONSTRAINT "Contribution_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavingsTransaction" ADD CONSTRAINT "SavingsTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FundTransaction" ADD CONSTRAINT "FundTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FundWithdrawal" ADD CONSTRAINT "FundWithdrawal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
