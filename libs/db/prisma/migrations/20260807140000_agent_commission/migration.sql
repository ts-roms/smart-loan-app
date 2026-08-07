-- Field agents and the commission they earn on what they originate.
--
-- An agent brings borrowers to the coop and is paid a fraction of the
-- principal on every loan they help land. They are staff with a login,
-- but the profile lives in its own table rather than as more columns on
-- "User": a deactivated agent still has a book of past loans and a
-- commission history, and that has to survive the account being closed.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'AGENT';

CREATE TABLE "Agent" (
  "id"             TEXT NOT NULL,
  "number"         TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  -- NULL means "use the product's rate", which is the common case.
  -- Nullable rather than defaulted to 0 because zero is a real rate —
  -- "this agent earns nothing here" — and a zero default would have
  -- silently stopped paying everyone the moment this column landed.
  "commissionRate" DECIMAL(5,4),
  "territory"      TEXT,
  "notes"          TEXT,
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "deactivatedAt"  TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "createdById"    TEXT,
  CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Agent_number_key" ON "Agent"("number");
-- One agent, one login. Without this an agent's book is ambiguous the
-- moment two rows point at the same user.
CREATE UNIQUE INDEX "Agent_userId_key" ON "Agent"("userId");
CREATE INDEX "Agent_active_idx" ON "Agent"("active");

-- Restrict: removing a user must not silently take a commission ledger
-- with it. Deactivate the agent instead.
ALTER TABLE "Agent"
  ADD CONSTRAINT "Agent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Agent"
  ADD CONSTRAINT "Agent_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Product-level default rate ────────────────────────────────────────
-- Zero, so a product nobody has configured pays nothing rather than
-- quietly paying a made-up rate.
ALTER TABLE "LoanProduct"
  ADD COLUMN "agentCommissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0;

-- ── The loan side ─────────────────────────────────────────────────────
ALTER TABLE "LoanApplication" ADD COLUMN "agentId"           TEXT;
ALTER TABLE "LoanApplication" ADD COLUMN "agentAssignedAt"   TIMESTAMP(3);
ALTER TABLE "LoanApplication" ADD COLUMN "agentAssignedById" TEXT;

-- Rate AND amount are frozen at assignment, not looked up on read. Same
-- reasoning as the kycDeclarations snapshot: an admin retuning the
-- product rate tomorrow must not restate what an agent earned on a loan
-- funded last quarter, in either direction.
ALTER TABLE "LoanApplication" ADD COLUMN "agentCommissionRate"     DECIMAL(5,4);
ALTER TABLE "LoanApplication" ADD COLUMN "agentCommissionAmount"   DECIMAL(14,2);
-- Set once, at disbursement. Its presence is what stops a second posting.
ALTER TABLE "LoanApplication" ADD COLUMN "agentCommissionPostedAt" TIMESTAMP(3);

-- SetNull on the agent: a loan whose agent record had to be removed is
-- still a perfectly ordinary loan, and the frozen figures above keep the
-- commission already paid auditable.
ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LoanApplication"
  ADD CONSTRAINT "LoanApplication_agentAssignedById_fkey"
  FOREIGN KEY ("agentAssignedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- An agent's own book is always scoped to one agent and always ordered
-- by time, so the index carries both.
CREATE INDEX "LoanApplication_agentId_submittedAt_idx"
  ON "LoanApplication"("agentId", "submittedAt");
