-- CreateEnum
CREATE TYPE "LoanType" AS ENUM ('SALARY', 'AUTOMOTIVE', 'MOTORCYCLE', 'HOUSING');

-- CreateEnum
CREATE TYPE "CollateralKind" AS ENUM ('NONE', 'VEHICLE', 'PROPERTY');

-- CreateEnum
CREATE TYPE "CollateralStatus" AS ENUM ('PROPOSED', 'VERIFIED', 'RELEASED', 'SEIZED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "KycDocumentType" ADD VALUE 'VEHICLE_OR';
ALTER TYPE "KycDocumentType" ADD VALUE 'VEHICLE_CR';
ALTER TYPE "KycDocumentType" ADD VALUE 'PROPERTY_TITLE';
ALTER TYPE "KycDocumentType" ADD VALUE 'TAX_DECLARATION';

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "propertyId" TEXT,
ADD COLUMN     "type" "LoanType" NOT NULL DEFAULT 'SALARY',
ADD COLUMN     "vehicleId" TEXT;

-- CreateTable
CREATE TABLE "LoanProduct" (
    "id" TEXT NOT NULL,
    "type" "LoanType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "collateralKind" "CollateralKind" NOT NULL DEFAULT 'NONE',
    "requiredKycDocs" "KycDocumentType"[],
    "minPrincipal" DECIMAL(14,2) NOT NULL,
    "maxPrincipal" DECIMAL(14,2) NOT NULL,
    "minTermMonths" INTEGER NOT NULL,
    "maxTermMonths" INTEGER NOT NULL,
    "defaultRate" DECIMAL(6,4) NOT NULL,
    "minRate" DECIMAL(6,4) NOT NULL,
    "maxRate" DECIMAL(6,4) NOT NULL,
    "maxLoanToValue" DECIMAL(5,4),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "plateNumber" TEXT,
    "chassisNumber" TEXT,
    "engineNumber" TEXT,
    "color" TEXT,
    "appraisedValue" DECIMAL(14,2) NOT NULL,
    "status" "CollateralStatus" NOT NULL DEFAULT 'PROPOSED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "propertyType" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT,
    "postalCode" TEXT,
    "titleNumber" TEXT,
    "taxDecNumber" TEXT,
    "areaSqm" DECIMAL(10,2),
    "appraisedValue" DECIMAL(14,2) NOT NULL,
    "status" "CollateralStatus" NOT NULL DEFAULT 'PROPOSED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanProduct_type_key" ON "LoanProduct"("type");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_vehicleId_key" ON "LoanApplication"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_propertyId_key" ON "LoanApplication"("propertyId");

-- CreateIndex
CREATE INDEX "LoanApplication_type_idx" ON "LoanApplication"("type");

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

