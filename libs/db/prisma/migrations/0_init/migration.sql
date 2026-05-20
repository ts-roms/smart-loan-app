-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."CreditTier" AS ENUM ('A', 'B', 'C', 'D', 'F');

-- CreateEnum
CREATE TYPE "public"."EmploymentStatus" AS ENUM ('EMPLOYED', 'SELF_EMPLOYED', 'UNEMPLOYED', 'RETIRED', 'STUDENT');

-- CreateEnum
CREATE TYPE "public"."GovernmentIdType" AS ENUM ('PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID', 'SSS', 'TIN', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."KycDocumentType" AS ENUM ('ID_FRONT', 'ID_BACK', 'PROOF_OF_INCOME', 'PROOF_OF_ADDRESS', 'SELFIE');

-- CreateEnum
CREATE TYPE "public"."KycStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."KycSubmissionStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."LoanStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'DISBURSED', 'ACTIVE', 'CLOSED', 'DEFAULTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('ADMIN', 'LOAN_OFFICER', 'ACCOUNTANT', 'CUSTOMER');

-- CreateTable
CREATE TABLE "public"."CreditScore" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "tier" "public"."CreditTier" NOT NULL,
    "breakdown" JSONB NOT NULL,
    "sourceSurveyId" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Customer" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT,
    "postalCode" TEXT,
    "governmentIdType" "public"."GovernmentIdType" NOT NULL,
    "governmentIdNumber" TEXT NOT NULL,
    "employmentStatus" "public"."EmploymentStatus" NOT NULL,
    "employerName" TEXT,
    "jobTitle" TEXT,
    "monthlyIncome" DECIMAL(14,2) NOT NULL,
    "yearsAtCurrentJob" DECIMAL(5,2),
    "kycStatus" "public"."KycStatus" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."KycSubmission" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "documentType" "public"."KycDocumentType" NOT NULL,
    "documentUrl" TEXT NOT NULL,
    "status" "public"."KycSubmissionStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "reason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "submittedById" TEXT NOT NULL,
    "decidedById" TEXT,

    CONSTRAINT "KycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoanApplication" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "annualInterestRate" DECIMAL(6,4) NOT NULL,
    "purpose" TEXT,
    "creditScoreAtApply" INTEGER,
    "tierAtApply" "public"."CreditTier",
    "status" "public"."LoanStatus" NOT NULL DEFAULT 'SUBMITTED',
    "decisionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "disbursedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "submittedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "disbursedById" TEXT,

    CONSTRAINT "LoanApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoanPayment" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,

    CONSTRAINT "LoanPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LoanSchedule" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "installmentNo" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "principalDue" DECIMAL(14,2) NOT NULL,
    "interestDue" DECIMAL(14,2) NOT NULL,
    "totalDue" DECIMAL(14,2) NOT NULL,
    "principalPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidInFullAt" TIMESTAMP(3),

    CONSTRAINT "LoanSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SurveyResponse" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "tier" "public"."CreditTier" NOT NULL,
    "breakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "computedById" TEXT NOT NULL,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "public"."UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditScore_customerId_computedAt_idx" ON "public"."CreditScore"("customerId" ASC, "computedAt" DESC);

-- CreateIndex
CREATE INDEX "Customer_governmentIdType_governmentIdNumber_idx" ON "public"."Customer"("governmentIdType" ASC, "governmentIdNumber" ASC);

-- CreateIndex
CREATE INDEX "Customer_phone_idx" ON "public"."Customer"("phone" ASC);

-- CreateIndex
CREATE INDEX "KycSubmission_customerId_documentType_idx" ON "public"."KycSubmission"("customerId" ASC, "documentType" ASC);

-- CreateIndex
CREATE INDEX "KycSubmission_status_idx" ON "public"."KycSubmission"("status" ASC);

-- CreateIndex
CREATE INDEX "LoanApplication_customerId_status_idx" ON "public"."LoanApplication"("customerId" ASC, "status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_number_key" ON "public"."LoanApplication"("number" ASC);

-- CreateIndex
CREATE INDEX "LoanApplication_status_submittedAt_idx" ON "public"."LoanApplication"("status" ASC, "submittedAt" ASC);

-- CreateIndex
CREATE INDEX "LoanPayment_loanId_paidOn_idx" ON "public"."LoanPayment"("loanId" ASC, "paidOn" DESC);

-- CreateIndex
CREATE INDEX "LoanSchedule_dueDate_idx" ON "public"."LoanSchedule"("dueDate" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "LoanSchedule_loanId_installmentNo_key" ON "public"."LoanSchedule"("loanId" ASC, "installmentNo" ASC);

-- CreateIndex
CREATE INDEX "SurveyResponse_customerId_computedAt_idx" ON "public"."SurveyResponse"("customerId" ASC, "computedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "User_customerId_key" ON "public"."User"("customerId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email" ASC);

-- AddForeignKey
ALTER TABLE "public"."CreditScore" ADD CONSTRAINT "CreditScore_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CreditScore" ADD CONSTRAINT "CreditScore_sourceSurveyId_fkey" FOREIGN KEY ("sourceSurveyId") REFERENCES "public"."SurveyResponse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KycSubmission" ADD CONSTRAINT "KycSubmission_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KycSubmission" ADD CONSTRAINT "KycSubmission_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KycSubmission" ADD CONSTRAINT "KycSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanApplication" ADD CONSTRAINT "LoanApplication_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanApplication" ADD CONSTRAINT "LoanApplication_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanApplication" ADD CONSTRAINT "LoanApplication_disbursedById_fkey" FOREIGN KEY ("disbursedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanApplication" ADD CONSTRAINT "LoanApplication_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanPayment" ADD CONSTRAINT "LoanPayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "public"."LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanPayment" ADD CONSTRAINT "LoanPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LoanSchedule" ADD CONSTRAINT "LoanSchedule_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "public"."LoanApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SurveyResponse" ADD CONSTRAINT "SurveyResponse_computedById_fkey" FOREIGN KEY ("computedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SurveyResponse" ADD CONSTRAINT "SurveyResponse_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

