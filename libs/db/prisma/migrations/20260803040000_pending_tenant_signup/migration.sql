-- PendingTenantSignup — a self-serve cooperative signup that hasn't
-- proved control of its email address yet.
--
-- Provisioning creates a Postgres schema, runs every migration against
-- it, seeds it, and mints an admin whose password is displayed exactly
-- once. Doing that straight off an anonymous POST means a typo'd
-- address yields a live tenant nobody can reach and nobody cleans up.
-- The signup lands here first; provisioning waits on a confirmed token.
--
-- Hand-written, like every migration here. `prisma migrate dev` cannot
-- be used in this repo: several indexes are partial (e.g.
-- AuditEvent_impersonatedById_idx has WHERE ... IS NOT NULL), which
-- @@index() cannot express, so the differ always wants to recreate them
-- and collides on the existing name.

CREATE TABLE "PendingTenantSignup" (
    "id" TEXT NOT NULL,
    -- Deliberately NOT unique: requesting a slug does not reserve it.
    -- Reserving on request would let anyone squat every good name with
    -- addresses they can't receive at. Whoever confirms first wins; the
    -- loser is told the name is taken.
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "adminName" TEXT NOT NULL,
    -- SHA-256 of the token in the confirmation link, never the token
    -- itself — same treatment as RefreshToken. A database leak must not
    -- hand anyone the ability to provision.
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    -- Kept rather than deleted on use, so a second click can say
    -- "already used" instead of "invalid".
    "consumedAt" TIMESTAMP(3),
    -- Slug actually provisioned, for tracing a pending row to its tenant.
    "tenantSlug" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingTenantSignup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingTenantSignup_tokenHash_key" ON "PendingTenantSignup"("tokenHash");

CREATE INDEX "PendingTenantSignup_adminEmail_idx" ON "PendingTenantSignup"("adminEmail");

-- Supports the sweep that removes expired unconfirmed rows.
CREATE INDEX "PendingTenantSignup_expiresAt_idx" ON "PendingTenantSignup"("expiresAt");
