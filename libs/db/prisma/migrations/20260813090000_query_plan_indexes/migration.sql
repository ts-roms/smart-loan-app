-- Indexes for the six hot queries whose plans showed a full scan that an index
-- can actually remove. Every one of these is backed by a captured EXPLAIN
-- ANALYZE, before and after, in docs/modernization/query-performance.md —
-- including the ones that were measured and REJECTED, which are recorded there
-- rather than added here.
--
-- Measured on a scratch database seeded to 50k customers / 120k loans / 1.3M
-- schedule rows / 800k journal lines. The dev database is empty of business
-- rows, so its plans prove nothing.
--
-- Table names are deliberately unqualified. `prisma migrate deploy` runs with
-- DATABASE_URL carrying `?schema=tenant_<slug>` (libs/db/src/lib/
-- multi-tenant-migrate.ts), so an unqualified name resolves to whichever
-- schema is being migrated. That is what makes the tenant fan-out in
-- libs/db/scripts/migrate-tenants.mjs apply these to every tenant and not just
-- to `public`. Do not schema-qualify them.
--
-- ROLLBACK: every statement here is a pure index addition — no column, no
-- constraint, no data touched, so the application can be rolled back and left
-- alone. If one of these ever needs to go, drop it by name; nothing reads it
-- except the planner.
--
-- LOCKING: plain CREATE INDEX takes a SHARE lock, which blocks writes to the
-- table (reads are unaffected) while it builds. At the volume measured above
-- the longest build was ~1.4s (LoanSchedule). CREATE INDEX CONCURRENTLY is
-- deliberately NOT used: Prisma wraps each migration file in a transaction and
-- CONCURRENTLY cannot run inside one, so shipping it here would fail the
-- migration outright. For any tenant materially larger than the measured
-- volume, see the manual runbook in docs/modernization/query-performance.md
-- ("Large tenants: concurrent build runbook") and build these by hand before
-- running the migration — CREATE INDEX is a no-op once the index exists.

-- The customer list, and every borrower picker that reuses it, orders by
-- createdAt desc and pages 200 rows at a time. Was: full scan + top-N sort.
CREATE INDEX "Customer_createdAt_idx" ON "Customer"("createdAt" DESC);

-- The default loans list has no status filter, so [status, submittedAt] cannot
-- serve its ordering — status leads. Was: full scan + top-N sort.
CREATE INDEX "LoanApplication_submittedAt_idx" ON "LoanApplication"("submittedAt" DESC);

-- YTD originations on the dashboard, and the bank-reconciliation disbursement
-- candidate search. NOT for the roll-rate report, which reads ~90% of the
-- table and correctly keeps its sequential scan.
CREATE INDEX "LoanApplication_disbursedAt_idx" ON "LoanApplication"("disbursedAt");

-- "Open instalments", optionally "and already due": the aging report, the
-- collections queue, and the nightly late-fee accrual driver all share this
-- shape. paidInFullAt leads because IS NULL is the selective half (~15% of
-- rows on a mature book) and btree indexes NULLs, so the pair becomes one
-- index condition instead of a filter over every instalment ever written.
CREATE INDEX "LoanSchedule_paidInFullAt_dueDate_idx" ON "LoanSchedule"("paidInFullAt", "dueDate");

-- Bank reconciliation matches a statement line to a payment by exact amount
-- inside a date window. [loanId, paidOn] cannot help: there is no loan id at
-- that point, which is the entire reason the match is being guessed.
CREATE INDEX "LoanPayment_amount_paidOn_idx" ON "LoanPayment"("amount", "paidOn");

-- Not a duplicate of journal_source_ref_unique, despite the identical column
-- list. Late-fee entries carry sourceRefId = '<scheduleId>:<n>' and are looked
-- up by LIKE '<scheduleId>:%'. Under this database's en_US.utf8 collation a
-- default-opclass btree cannot answer a prefix range at all, so the unique
-- index narrowed to (source, sourceRefType) and then filtered ~100k rows
-- through the heap. text_pattern_ops compares byte-wise, which turns the
-- prefix into an index condition. The unique index keeps its collation
-- semantics because it enforces posting idempotency.
CREATE INDEX "JournalEntry_source_refType_refId_prefix_idx"
  ON "JournalEntry"("source", "sourceRefType", "sourceRefId" text_pattern_ops);
