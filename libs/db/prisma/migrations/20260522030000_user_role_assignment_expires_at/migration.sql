-- Phase 4B: optional expiry on UserRoleAssignment.
--
-- NULL = perpetual (existing rows backfill to NULL). When set and in
-- the past, the permission resolver filters the assignment out so the
-- user no longer effectively holds the role.
ALTER TABLE "UserRoleAssignment"
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Read-side index for the optional sweep cron and any "expiring soon"
-- listing query. NULLs sort last under default Postgres semantics,
-- which is what we want — perpetual rows are filtered out of any
-- "WHERE expiresAt < now()" lookup automatically.
CREATE INDEX IF NOT EXISTS "UserRoleAssignment_expiresAt_idx"
  ON "UserRoleAssignment"("expiresAt");
