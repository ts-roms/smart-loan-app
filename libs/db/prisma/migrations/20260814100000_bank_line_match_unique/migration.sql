-- One payment, one bank line. Enforced where it can actually be enforced.
--
-- Reconciliation is a one-to-one correspondence: a recorded payment is
-- the explanation for exactly one credit on the statement, and a
-- disbursement for exactly one debit. Two lines pointing at one payment
-- means the statement reports itself fully reconciled while a real
-- deposit is unaccounted for — which is the precise discrepancy this
-- feature exists to surface, so absorbing it silently is worse than
-- leaving a line unmatched.
--
-- Nothing at the database level said so. `autoMatch` keeps a claim set in
-- memory for the length of its run and `manualMatch` does a SELECT before
-- its UPDATE; both are correct on their own and neither survives a second
-- writer. Two autoMatch runs, or a manual match racing a run, both read
-- "unclaimed" and both write. This is the check-then-act shape recorded
-- as F2 in docs/modernization/query-performance.md, and this codebase has
-- a settled answer to it: a check followed by an action is something a
-- second request walks between, a unique index is not. It is the same
-- answer 20260811120000_journal_source_ref_unique gave for double-posting
-- and 20260811130000_payment_idempotency_key gave for double-charging.
--
-- ── Why PARTIAL, and why hand-written ───────────────────────────────────
--
-- The index covers only rows where BOTH columns are non-null:
--
--   * Unmatched lines are the normal state and there are many of them.
--     Postgres treats NULLs as distinct, so a plain unique index would
--     not actually collide on them — but the predicate keeps the index
--     off those rows entirely, which is the point on a table that is
--     mostly unmatched.
--   * `MANUAL` and other free-text types legitimately repeat. A bank
--     fee, an interest credit, an owner draw — several lines are
--     explained the same way and carry no refId at all. They have
--     matchedType set and matchedRefId null, and the predicate exempts
--     them, matching the exemption manualMatch already applies in code.
--
-- Prisma's `@@unique` cannot express a WHERE clause, and Prisma skips
-- partial indexes at introspection — so declaring this in schema.prisma
-- as a plain `@@unique` would make `migrate diff` report phantom drift
-- forever, which is exactly what e10f06a just finished repairing. The
-- index therefore lives here and only here, and BankStatementLine in
-- schema.prisma carries a comment saying so, matching the convention
-- already used for Customer_erasedAt_idx and
-- AuditEvent_impersonatedById_idx.
--
-- Named by hand rather than by Prisma's derivation, following
-- `journal_source_ref_unique`: this is a constraint the repo owns, not
-- one Prisma generated.
--
-- ── Existing duplicates ─────────────────────────────────────────────────
--
-- A database that has been reconciling for a while may already hold the
-- duplicates this index forbids — every one of them created by the race
-- described above. CREATE UNIQUE INDEX would simply fail on such a
-- database and leave the migration unapplied, so it is dealt with first
-- and explicitly.
--
-- The rule: the earliest claim stands, later ones are released. Ordering
-- by matchedAt (then id, to break ties deterministically and to give
-- rows with a null matchedAt a stable position) means the line that was
-- reconciled first keeps the payment, and the ones that piled on top go
-- back to unmatched.
--
-- Nothing is deleted. The statement line itself — the bank's own record
-- of a real movement of cash — is untouched; only the disputed CLAIM is
-- cleared, and what it used to claim is written into matchNote so the
-- reconciler can see what happened and redo it by hand. A released line
-- reappears in the unmatched queue, which is where a line that nobody
-- has genuinely explained belongs.
--
-- On this repo's dev database the query below matched zero rows.
--
-- Table name is deliberately unqualified. `prisma migrate deploy` runs
-- with DATABASE_URL carrying `?schema=tenant_<slug>`, so it resolves to
-- whichever schema is being migrated — that is what lets the fan-out in
-- libs/db/scripts/migrate-tenants.mjs apply this to every tenant. Do not
-- schema-qualify it.
--
-- LOCKING: plain CREATE UNIQUE INDEX takes a SHARE lock, blocking writes
-- to BankStatementLine (reads are unaffected) while it builds. Statement
-- line volume is bounded by how much bank statement a coop imports, so
-- this is small. CREATE INDEX CONCURRENTLY is deliberately not used:
-- Prisma wraps each migration file in a transaction and CONCURRENTLY
-- cannot run inside one.
--
-- ROLLBACK: `DROP INDEX "bank_line_match_unique";`. The UPDATE above it
-- is not reversible from the index's side — but it destroyed no row, and
-- each line it touched says in its own matchNote what it used to be
-- matched to, so a reconciler can restore any claim by hand. Rolling the
-- application back without dropping the index is also safe: the old code
-- creates duplicates only under a race it was already losing, and would
-- now get an error instead of silent corruption.

-- Release every claim but the earliest on each (matchedType, matchedRefId).
WITH ranked AS (
  SELECT
    "id",
    "matchedType",
    "matchedRefId",
    row_number() OVER (
      PARTITION BY "matchedType", "matchedRefId"
      ORDER BY "matchedAt" ASC NULLS LAST, "id" ASC
    ) AS rn
  FROM "BankStatementLine"
  WHERE "matchedType" IS NOT NULL
    AND "matchedRefId" IS NOT NULL
)
UPDATE "BankStatementLine" AS l
SET
  "matchedType"  = NULL,
  "matchedRefId" = NULL,
  "matchedAt"    = NULL,
  "matchedById"  = NULL,
  "matchNote"    = concat_ws(
    ' | ',
    NULLIF(l."matchNote", ''),
    'Released by migration 20260814100000: this line also claimed ('
      || r."matchedType" || ', ' || r."matchedRefId"
      || '), which an earlier line had already claimed. Re-reconcile.'
  )
FROM ranked AS r
WHERE l."id" = r."id"
  AND r.rn > 1;

CREATE UNIQUE INDEX "bank_line_match_unique"
  ON "BankStatementLine" ("matchedType", "matchedRefId")
  WHERE "matchedType" IS NOT NULL AND "matchedRefId" IS NOT NULL;
