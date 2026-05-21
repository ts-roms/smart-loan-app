-- ──────────────────────────────────────────────────────────────────────
-- Loan approval chain (per-product workflow)
--
-- Adds two new tables plus a column on LoanApplication so a loan can
-- carry its position in the chain. Existing loans get currentApprovalStep
-- = NULL (legacy single-decide flow); they continue to use
-- LoanApplication.decidedById / decidedAt as before. New loans for
-- products that gain a chain pick it up at submit time.
-- ──────────────────────────────────────────────────────────────────────

-- Status enum mirrors the Prisma model.
CREATE TYPE "LoanApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED');

-- ── Approval chain definition per product ────────────────────────────
CREATE TABLE "LoanApprovalStep" (
  "id"                 TEXT NOT NULL,
  "productCode"        TEXT NOT NULL,
  "order"              INTEGER NOT NULL,
  "label"              TEXT NOT NULL,
  "requiredPermission" TEXT NOT NULL,
  "optional"           BOOLEAN NOT NULL DEFAULT false,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoanApprovalStep_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoanApprovalStep_productCode_order_key"
  ON "LoanApprovalStep"("productCode", "order");
CREATE INDEX "LoanApprovalStep_productCode_idx"
  ON "LoanApprovalStep"("productCode");

ALTER TABLE "LoanApprovalStep" ADD CONSTRAINT "LoanApprovalStep_productCode_fkey"
  FOREIGN KEY ("productCode") REFERENCES "LoanProduct"("code")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Per-loan approval rows (one per step) ────────────────────────────
CREATE TABLE "LoanApproval" (
  "id"                       TEXT NOT NULL,
  "loanId"                   TEXT NOT NULL,
  "stepOrder"                INTEGER NOT NULL,
  "stepLabel"                TEXT NOT NULL,
  "requiredPermission"       TEXT NOT NULL,
  "status"                   "LoanApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "notes"                    TEXT,
  "approverId"               TEXT,
  "approvedAt"               TIMESTAMP(3),
  "signedUnderDelegationId"  TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoanApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoanApproval_loanId_stepOrder_key"
  ON "LoanApproval"("loanId", "stepOrder");
CREATE INDEX "LoanApproval_loanId_status_idx"
  ON "LoanApproval"("loanId", "status");
CREATE INDEX "LoanApproval_approverId_idx"
  ON "LoanApproval"("approverId");

ALTER TABLE "LoanApproval" ADD CONSTRAINT "LoanApproval_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LoanApproval" ADD CONSTRAINT "LoanApproval_approverId_fkey"
  FOREIGN KEY ("approverId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LoanApproval" ADD CONSTRAINT "LoanApproval_signedUnderDelegationId_fkey"
  FOREIGN KEY ("signedUnderDelegationId") REFERENCES "Delegation"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── LoanApplication.currentApprovalStep ──────────────────────────────
-- Nullable for back-compat: existing rows leave it null (legacy flow);
-- LoanRepository.apply() sets it to 1 on new loans whose product has a
-- chain configured.
ALTER TABLE "LoanApplication"
  ADD COLUMN "currentApprovalStep" INTEGER;
