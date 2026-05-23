-- GDPR / Data Privacy Act compliance: track when a Customer's PII was
-- erased and by whom. The PII columns themselves are not dropped — the
-- erasure service overwrites them in place with deterministic
-- placeholders so financial relations (LoanApplication, JournalEntry,
-- AuditEvent) keep referring to a valid Customer.id while the human-
-- readable PII is gone.
--
-- Why columns and not a separate ErasureLog table:
--   - "Is this customer erased?" is checked every time the row is
--     read. Two columns on the same row is one index hit; a join to
--     a separate table is two.
--   - The companion AuditEvent row (action=CUSTOMER_ERASE) carries the
--     full erasure metadata (reason, fields cleared) — this just
--     marks the row.
--
-- See apps/api/src/features/compliance/compliance.service.ts.

ALTER TABLE "Customer"
  ADD COLUMN "erasedAt"   TIMESTAMP(3),
  ADD COLUMN "erasedById" TEXT;

-- Filter index for compliance reports ("how many erasures in the last
-- 30 days?"). Partial so it only covers the erased subset.
CREATE INDEX "Customer_erasedAt_idx"
  ON "Customer" ("erasedAt" DESC)
  WHERE "erasedAt" IS NOT NULL;
