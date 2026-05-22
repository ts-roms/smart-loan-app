-- Phase 4C: permission staging.
--
-- DRAFT       — perm exists in the catalog but the resolver does not
--               grant it. Lets admins wire role membership before
--               flipping the perm on for real.
-- ACTIVE      — fully effective (historical default).
-- DEPRECATED  — still effective at runtime so in-flight flows don't
--               break, but the UI flags it for planned removal.
--
-- Existing rows backfill to ACTIVE.
CREATE TYPE "PermissionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DEPRECATED');

ALTER TABLE "Permission"
  ADD COLUMN IF NOT EXISTS "status" "PermissionStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX IF NOT EXISTS "Permission_status_idx" ON "Permission"("status");
