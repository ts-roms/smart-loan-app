-- AlterTable
ALTER TABLE "CoMaker" ADD COLUMN     "signatureUrl" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN     "agreementHash" TEXT,
ADD COLUMN     "borrowerSignatureUrl" TEXT,
ADD COLUMN     "borrowerSignedAt" TIMESTAMP(3),
ADD COLUMN     "borrowerSignedFromIp" TEXT,
ADD COLUMN     "officerSignatureUrl" TEXT,
ADD COLUMN     "officerSignedAt" TIMESTAMP(3),
ADD COLUMN     "officerSignedById" TEXT;

