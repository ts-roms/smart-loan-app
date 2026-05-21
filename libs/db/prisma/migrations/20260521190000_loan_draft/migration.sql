-- LoanDraft: in-progress wizard state, one row per WIP application.
-- Wholly additive — no existing data is touched. Cascade-delete on
-- author so deactivated users don't leave orphans.

CREATE TABLE "LoanDraft" (
  "id"          TEXT NOT NULL,
  "authorId"    TEXT NOT NULL,
  "customerId"  TEXT,
  "productCode" TEXT,
  "lastStep"    INTEGER NOT NULL DEFAULT 0,
  "formState"   JSONB NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LoanDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoanDraft_authorId_updatedAt_idx"
  ON "LoanDraft"("authorId", "updatedAt" DESC);

ALTER TABLE "LoanDraft"
  ADD CONSTRAINT "LoanDraft_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
