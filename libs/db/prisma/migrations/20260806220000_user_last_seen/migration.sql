-- Presence heartbeat.
--
-- Nothing in this schema could answer "is this person online". A live
-- RefreshToken means "signed in sometime in the last 30 days", and
-- AuditEvent only records mutations, so a user reading reports all day
-- looked idle. This column is the missing signal.
--
-- A timestamp rather than a boolean, on purpose: a stored `isOnline`
-- flag has no way to become false. A crashed API process, a closed
-- laptop, or dead wifi all leave it stuck true forever, because the
-- event that would clear it is exactly the event that didn't happen.
-- A timestamp decays without anyone having to remember to clear it,
-- and the reader decides what "recent" means.
--
-- Written from app.authenticate, throttled so it is at most one write
-- per user per heartbeat interval no matter how many requests they
-- make.

ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- Deliberately NOT indexed, same reasoning as "sessionsRevokedAt".
-- This is now the hottest-written column on User, and the only read is
-- by primary key as part of a row the session check already fetches.
-- An index would be paid on every heartbeat to serve a filtered
-- "who is online" query that does not exist yet. Add it alongside that
-- query, not before it.

-- Backfill note: left NULL for existing rows rather than defaulted to
-- now(). NULL means "never seen", which is the truth for a user who
-- has not signed in since this shipped; CURRENT_TIMESTAMP would have
-- shown the entire staff list as online the moment it deployed.
