-- Paying the agents.
--
-- Disbursing a loan books the commission as an EXPENSE and a PAYABLE:
-- the agent has earned it and the coop now owes it. A payout is the
-- other half — the cash leaving, and account 2500 coming down.
--
-- One payout covers one agent and names exactly which loans it settled.
-- "We paid you ₱14,000 last month" is not an answer to "which of my
-- loans was that for"; the line items are, and they are also what makes
-- paying the same commission twice impossible.

CREATE TABLE "AgentPayout" (
  "id"          TEXT NOT NULL,
  "number"      TEXT NOT NULL,
  "agentId"     TEXT NOT NULL,
  -- Stored rather than derived, and validated against the items on
  -- creation, so the figure always reconciles with the cash that left.
  "amount"      DECIMAL(14,2) NOT NULL,
  "paidOn"      TIMESTAMP(3) NOT NULL,
  -- Free text, not an enum: "CASH" / "BANK_TRANSFER" / "GCASH" is the
  -- coop's vocabulary, and it is not this codebase's business to
  -- legislate which payment rails a cooperative may use.
  "method"      TEXT,
  "reference"   TEXT,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT,
  -- Voided, never deleted. A payout that hit the ledger is reversed
  -- with a mirror entry and both stand — which is what an audit expects
  -- to find where money moved and then moved back.
  "voidedAt"    TIMESTAMP(3),
  "voidReason"  TEXT,
  "voidedById"  TEXT,
  CONSTRAINT "AgentPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentPayout_number_key" ON "AgentPayout"("number");
CREATE INDEX "AgentPayout_agentId_paidOn_idx" ON "AgentPayout"("agentId", "paidOn");

-- Restrict: an agent with a payment history cannot be deleted out from
-- under it. Deactivate them instead.
ALTER TABLE "AgentPayout"
  ADD CONSTRAINT "AgentPayout_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AgentPayout"
  ADD CONSTRAINT "AgentPayout_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentPayout"
  ADD CONSTRAINT "AgentPayout_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgentPayoutItem" (
  "id"       TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "loanId"   TEXT NOT NULL,
  "amount"   DECIMAL(14,2) NOT NULL,
  CONSTRAINT "AgentPayoutItem_pkey" PRIMARY KEY ("id")
);

/*
 * The constraint that makes double payment impossible.
 *
 * UNIQUE, not merely an index. Without it two payout runs started in the
 * same second both read the loan as unpaid and both insert: the agent is
 * paid twice for one loan and account 2500 goes negative. Wrapping each
 * run in a transaction would NOT catch that — the two touch no common
 * row until this one.
 *
 * On the loan alone rather than (payoutId, loanId), because the rule is
 * one payment per loan across ALL payouts, not per payout. Voiding
 * cascades the items away, which is exactly what frees a loan to be
 * paid again on a corrected run.
 */
CREATE UNIQUE INDEX "AgentPayoutItem_loanId_key" ON "AgentPayoutItem"("loanId");
CREATE INDEX "AgentPayoutItem_payoutId_idx" ON "AgentPayoutItem"("payoutId");

ALTER TABLE "AgentPayoutItem"
  ADD CONSTRAINT "AgentPayoutItem_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "AgentPayout"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict: a loan carrying a settled commission cannot be deleted
-- while the payout that settled it still stands.
ALTER TABLE "AgentPayoutItem"
  ADD CONSTRAINT "AgentPayoutItem_loanId_fkey"
  FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
