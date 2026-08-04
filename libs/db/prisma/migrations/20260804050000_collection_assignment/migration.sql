-- Collections ownership: a COLLECTOR role and an assignee per account.
--
-- The collections queue is derived, not stored — every active loan with
-- an unpaid installment past due, recomputed per request. That works as
-- a shared worklist but nobody owns anything: no "my accounts", no
-- handover trail, and nothing to measure a collector against. This adds
-- the owner, and a role for the people who do the work.
--
-- Hand-written, like every migration here. `prisma migrate dev` cannot
-- be used in this repo: several indexes are partial (e.g.
-- AuditEvent_impersonatedById_idx has WHERE ... IS NOT NULL), which
-- @@index() cannot express, so the differ always wants to recreate them
-- and collides on the existing name.

-- New enum member. Postgres appends to the END of the enum's sort order,
-- which is what the schema declares too (COLLECTOR before CUSTOMER is
-- editorial, not ordinal) — nothing in the app orders by role, so the
-- mismatch is cosmetic. Adding a member is not transactional on older
-- Postgres, hence its own statement ahead of the table.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'COLLECTOR';

CREATE TABLE "CollectionAssignment" (
    "id" TEXT NOT NULL,
    -- One current owner per loan. Reassignment overwrites this row; the
    -- audit log carries the history, so keeping a second copy here would
    -- just be something else to keep in sync.
    "loanId" TEXT NOT NULL,
    -- Not restricted to COLLECTOR users. Officers and admins work
    -- accounts too, and "may this user be assigned" is a rule the API
    -- enforces at write time, where it can return a real error.
    "collectorId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Handover context: "borrower speaks Ilocano", "escalated from Ana,
    -- broke two PTPs".
    "note" TEXT,

    CONSTRAINT "CollectionAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CollectionAssignment_loanId_key"
    ON "CollectionAssignment"("loanId");

-- The collector dashboard's primary read: every account owned by one
-- user.
CREATE INDEX "CollectionAssignment_collectorId_idx"
    ON "CollectionAssignment"("collectorId");

-- Cascade on the loan: an assignment to a deleted loan is meaningless.
ALTER TABLE "CollectionAssignment"
    ADD CONSTRAINT "CollectionAssignment_loanId_fkey"
    FOREIGN KEY ("loanId") REFERENCES "LoanApplication"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade on the collector: deleting the user retires their queue, and
-- the accounts fall back to unassigned rather than pointing at a ghost.
ALTER TABLE "CollectionAssignment"
    ADD CONSTRAINT "CollectionAssignment_collectorId_fkey"
    FOREIGN KEY ("collectorId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT on the assigner: who handed the account over is audit
-- information, so the supervisor's user row can't be deleted out from
-- under it.
ALTER TABLE "CollectionAssignment"
    ADD CONSTRAINT "CollectionAssignment_assignedById_fkey"
    FOREIGN KEY ("assignedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
