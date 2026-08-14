-- §56 audit-trail completeness.
--
-- Two things: the request-provenance and structured-change columns AuditEvent
-- was missing, and a LoginAttempt table for the auth events that AuditEvent
-- structurally cannot hold.
--
-- Table names are deliberately unqualified. `prisma migrate deploy` runs with
-- DATABASE_URL carrying `?schema=tenant_<slug>` (libs/db/src/lib/
-- multi-tenant-migrate.ts), so an unqualified name resolves to whichever
-- schema is being migrated. That is what makes the tenant fan-out in
-- libs/db/scripts/migrate-tenants.mjs apply this to every tenant and not just
-- to `public`. Do not schema-qualify them.
--
-- DATA-PRESERVING: every added column is nullable with no default, so this is
-- a catalog-only change on AuditEvent — existing rows are not rewritten and
-- not touched. Nullable is also the honest answer for them: rows written
-- before this migration have no provenance to backfill, and a NOT NULL DEFAULT
-- would have manufactured a value that looks like evidence and is not.
--
-- ROLLBACK: safe and mechanical. Nothing here alters or drops an existing
-- object, so the previous application version runs unchanged against this
-- schema (it simply never writes the new columns) — which means the normal
-- rollback is to redeploy the old code and LEAVE THE SCHEMA ALONE. If the
-- schema itself must be reverted:
--
--   DROP TABLE "LoginAttempt";
--   DROP INDEX "AuditEvent_requestId_idx";
--   ALTER TABLE "AuditEvent"
--     DROP COLUMN "tenantId", DROP COLUMN "ipAddress", DROP COLUMN "userAgent",
--     DROP COLUMN "requestId", DROP COLUMN "oldValue", DROP COLUMN "newValue",
--     DROP COLUMN "reason";
--
-- Note that dropping them destroys audit evidence that cannot be
-- reconstructed. Prefer redeploying the old application version.
--
-- LOCKING: `ADD COLUMN ... NULL` with no default is metadata-only in
-- PostgreSQL 11+ — no table rewrite, an ACCESS EXCLUSIVE lock held for the
-- catalog update only. CREATE TABLE and the index on the new empty table are
-- likewise instant. The one statement with real work is the index on
-- AuditEvent("requestId"), which takes a SHARE lock (blocking writes to
-- AuditEvent, reads unaffected) for the duration of the build. AuditEvent is
-- small on every tenant measured; CREATE INDEX CONCURRENTLY is deliberately
-- not used because Prisma wraps each migration file in a transaction and
-- CONCURRENTLY cannot run inside one. For a tenant with a very large
-- AuditEvent, build that one index by hand before running the migration —
-- CREATE INDEX is a no-op once the index exists.

-- ─── AuditEvent: §56 request provenance + structured change record ───────────
--
-- tenantId/ipAddress/userAgent/requestId answer "who, from where, under which
-- request". oldValue/newValue/reason are the structured slots that make "what
-- changed" answerable without knowing each call site's private `payload`
-- convention. `payload` itself is untouched — two dozen call sites write
-- ad-hoc shapes into it and none are being rewritten here.
ALTER TABLE "AuditEvent" ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "newValue" JSONB,
ADD COLUMN     "oldValue" JSONB,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "tenantId" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- ─── LoginAttempt: the auth security log ─────────────────────────────────────
--
-- Separate from AuditEvent because AuditEvent."actorId" is a NOT NULL foreign
-- key to User, and the failed login that matters most — one against an address
-- that does not exist — has no user row to point at. A brute-force sweep
-- across invented addresses is exactly the event §56 wants recorded and
-- exactly the event AuditEvent cannot hold.
--
-- "userId" carries NO foreign key, deliberately. An FK would be unsatisfiable
-- for the unknown-address case, and it would couple this security log to the
-- lifetime of the User row — so erasing a user under §71 would either cascade
-- away the evidence of attacks against their account or block the erasure.
-- The security log has to outlive the account it describes.
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "success" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "tenantId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "Is this account under attack?" — the lockout / alerting query.
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt" DESC);

-- CreateIndex
-- The same question asked per origin, which is the one that catches a spray
-- across many addresses that a per-email view cannot see.
CREATE INDEX "LoginAttempt_ipAddress_createdAt_idx" ON "LoginAttempt"("ipAddress", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt" DESC);

-- CreateIndex
-- "Show me everything that happened under request X" — the query a support
-- ticket turns into once the caller quotes the X-Request-Id they were given.
-- No index on "tenantId": under schema-per-tenant every row in a given schema
-- has the same value, so it would never narrow anything.
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");
