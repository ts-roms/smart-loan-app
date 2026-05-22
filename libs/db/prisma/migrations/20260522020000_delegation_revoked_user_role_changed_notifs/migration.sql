-- Lifecycle notifications for delegation + role changes.
--
--   DELEGATION_REVOKED → delegate is notified when a delegation they
--     hold is revoked early (before its scheduled endsAt). Fired
--     inline from the delegations.revoke endpoint, all 3 channels
--     (in-app bell + email + SMS where contact info exists).
--
--   USER_ROLE_CHANGED → user is notified when a role is assigned to
--     or removed from their account. Fired inline from
--     rbac.assignRole / rbac.unassignRole.
--
-- Templates live in libs/notifications/src/index.ts; the event keys
-- here are the wire contract.
--
-- IF NOT EXISTS so a re-run on a partially-migrated DB is a no-op.
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'DELEGATION_REVOKED';
ALTER TYPE "NotificationEvent" ADD VALUE IF NOT EXISTS 'USER_ROLE_CHANGED';
