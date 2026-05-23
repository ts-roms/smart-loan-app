-- Compliance: propagate impersonatedBy onto every AuditEvent row written
-- during a platform-impersonated session. Two columns over JSON because
-- the compliance team queries them constantly ("show me everything
-- VENDOR_OPS did against acme-coop last month") and a JSON index would
-- be over-engineering for two fields.
--
-- Both nullable: the vast majority of audit rows are non-impersonated.
-- See apps/api/src/features/platform/platform.service.ts → impersonateTenant
-- for the JWT claim shape, and libs/db/src/repositories/audit-log.repository.ts
-- for the write path.

ALTER TABLE "AuditEvent"
  ADD COLUMN "impersonatedById"    TEXT,
  ADD COLUMN "impersonatedByEmail" TEXT;

-- Filter index: "audit log entries that happened during a support session."
-- Partial so the index only covers the impersonated subset (typically <1%
-- of rows); skinnier on disk and faster to scan than a full b-tree.
CREATE INDEX "AuditEvent_impersonatedById_idx"
  ON "AuditEvent" ("impersonatedById")
  WHERE "impersonatedById" IS NOT NULL;
