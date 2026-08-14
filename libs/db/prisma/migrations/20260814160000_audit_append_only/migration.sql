-- §56 append-only, enforced where the data is.
--
-- `AuditLogRepository` exposes no update and no delete path. That is a
-- convention held by one file, and the application role holds full DML on the
-- table: a repair script, a psql session, a future repository method, an ORM
-- cascade, or a `deleteMany` with a wrong `where` all reach the rows without
-- going near that convention.
-- 20260520070000_selfie_and_audit created "AuditEvent" with a plain primary
-- key, four indexes and one foreign key — no trigger, no rule, no RLS, no
-- revoked grant. Nothing below the application said the log was append-only.
--
-- This is the same argument 20260814090000_financial_record_restrict made for
-- the money tables: a rule the application merely follows is not a rule, and
-- the guard has to live where the data does.
--
-- ── Why a trigger, and not one of the alternatives ──────────────────────────
--
--   * REVOKE UPDATE, DELETE from the application role. Stronger in principle
--     and unusable here: the retention purge runs as that same role, in the
--     same process, over the same pool. Revoking would either break the purge
--     or require a second database role — and roles are CLUSTER-global while
--     everything else in this schema is per-tenant, so a role-based guard
--     cannot be expressed inside a migration that is replayed once per tenant
--     schema. The whole multi-tenant model would have to change to carry it.
--   * A SECURITY DEFINER purge function owned by a separate role. Same
--     cluster-global role problem, plus it moves the retention predicate out
--     of TypeScript and into SQL where the closed operational list would have
--     to be duplicated and would drift.
--   * Row-level security. RLS filters what a role can SEE and touch by
--     predicate; it has no notion of "this transaction is the purge", which is
--     precisely the distinction that has to be drawn.
--   * A rule (CREATE RULE ... DO INSTEAD NOTHING). Silently swallows the
--     write. An audit log that pretends to accept a delete is worse than one
--     that refuses it loudly.
--
-- A BEFORE trigger is the only mechanism that is per-schema, role-independent,
-- and able to distinguish an authorised transaction from an unauthorised one.
--
-- ── The opt-in, and why it is bound to the transaction id ───────────────────
--
-- The purge announces itself by setting a custom GUC:
--
--   SELECT set_config('app.audit_retention_purge', pg_current_xact_id()::text, true);
--
-- Two properties, both required, both verified against this database before
-- this migration was written:
--
--   1. `is_local = true` (the function form of SET LOCAL) reverts at COMMIT or
--      ROLLBACK. Issued OUTSIDE an explicit transaction block it is discarded
--      at the end of the implicit single-statement transaction — so a caller
--      that forgets to open a transaction gets a refused purge, not a silently
--      widened one. The failure direction is the safe one.
--
--   2. The VALUE is the current transaction id, and the trigger requires it to
--      equal `pg_current_xact_id()` at the moment it fires. This is what makes
--      the flag un-leakable. `SET LOCAL` alone is already transaction-scoped,
--      but the mistake it does not protect against is someone writing plain
--      `SET` (session-scoped) — on a pooled connection, or behind PgBouncer in
--      transaction mode, that setting outlives the request and silently arms
--      every later transaction that borrows the connection, including other
--      tenants' requests. Bound to a transaction id, a leaked session-level
--      setting matches nothing: the next transaction has a different id.
--
-- Neither GUC name is one anything else would set, and no value except a live
-- transaction id is ever accepted, so there is no "on"/"true"/"1" to be turned
-- on by a debugging session or a connection-string parameter.
--
-- The helpers that set these live in libs/db/src/lib/audit-append-only.ts and
-- are the only supported way to claim either window.
--
-- ── UPDATE: redaction in place, never deletion ──────────────────────────────
--
-- "ipAddress" and "userAgent" are personal data under §71, but the row they
-- sit on is a §56 record. Nulling those two columns satisfies both
-- obligations; deleting the row satisfies one by destroying the other. So
-- UPDATE gets its own window, `app.audit_pii_redaction`, and the trigger
-- checks the SHAPE of the update rather than trusting the flag: holding the
-- redaction window lets you null "ipAddress" and "userAgent" and nothing else.
-- Rewriting "action", "payload", "actorId" or "createdAt" is refused even with
-- the flag set.
--
-- The shape check compares the whole row as jsonb with those two keys removed,
-- rather than listing the columns that must not change. A column list would
-- have to be edited every time "AuditEvent" gains a column, and the failure
-- mode of forgetting is silent (the new column becomes freely rewritable under
-- the redaction window). The jsonb form covers columns that do not exist yet.
-- It costs two row-to-jsonb conversions per redacted row, which is paid once
-- per row per lifetime on a nightly batch.
--
-- ── What this does NOT stop ────────────────────────────────────────────────
--
-- A SUPERUSER. `SET session_replication_role = 'replica'` suppresses ordinary
-- triggers, and the table owner can `ALTER TABLE ... DISABLE TRIGGER`. On this
-- repo's dev database the application role `loan` IS a superuser, which means
-- the guard is advisory there. In production the application must connect as a
-- non-superuser, non-owner role for this trigger to be worth anything — that
-- is a deployment requirement this migration cannot enforce from inside a
-- schema, and it is recorded here so it is not discovered later.
-- DROP TABLE and DROP TRIGGER are likewise DDL and out of reach; the guard is
-- against DML reaching the rows, which is the path an accident actually takes.
--
-- ── Tenancy ────────────────────────────────────────────────────────────────
--
-- Every name here is deliberately unqualified. `prisma migrate deploy` runs
-- with DATABASE_URL carrying `?schema=tenant_<slug>` (libs/db/src/lib/
-- multi-tenant-migrate.ts), so unqualified names resolve to whichever schema
-- is being migrated — that is what makes the fan-out in
-- libs/db/scripts/migrate-tenants.mjs apply this to every tenant and not just
-- to `public`. Do not schema-qualify them.
--
-- That applies to the FUNCTIONS as much as to the table: each tenant schema
-- gets its own copy of `audit_event_append_only()`, and `CREATE TRIGGER`
-- resolves the function through the same search_path and stores its OID, so a
-- tenant's trigger is bound to that tenant's function. Verified by replaying
-- the migration history into a scratch `tenant_*` schema and reading
-- pg_trigger/pg_proc back per schema — not assumed.
--
-- DATA-PRESERVING: no row is read, written or deleted by this migration. The
-- two trigger creations and one function creation are catalog-only. The single
-- ALTER TABLE adds a NOT NULL column WITH a constant default, which since
-- PostgreSQL 11 is a catalog-only operation as well — no table rewrite.
--
-- LOCKING: CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on "AuditEvent",
-- blocking writes (not reads) for the length of the catalog update, which is
-- microseconds. `ADD COLUMN ... NOT NULL DEFAULT <constant>` takes ACCESS
-- EXCLUSIVE on "SystemConfig" for the same order of time; "SystemConfig" is a
-- single-row table.
--
-- ROLLBACK: fully mechanical, and the previous application version runs
-- unchanged against this schema in one direction only — it never sets either
-- GUC, so its (nonexistent) audit updates are unaffected, but ITS RETENTION
-- PURGE WILL FAIL, because it deletes audit rows without claiming the window.
-- That is the one incompatibility, and it is a nightly job failing loudly
-- rather than data being lost. To revert the schema:
--
--   DROP TRIGGER "AuditEvent_append_only" ON "AuditEvent";
--   DROP TRIGGER "AuditEvent_no_truncate" ON "AuditEvent";
--   DROP FUNCTION "audit_event_append_only"();
--   DROP FUNCTION "audit_event_no_truncate"();
--   ALTER TABLE "SystemConfig" DROP COLUMN "loginAttemptRetentionDays";
--
-- Dropping the triggers is non-destructive and instant, and is the correct
-- emergency lever if the trigger turns out to refuse a legitimate operation in
-- production: it restores exactly today's behaviour. See
-- docs/modernization/ for what to monitor (SQLSTATE AP001/AP002).

-- ─── The append-only trigger function ────────────────────────────────────────
--
-- SQLSTATE AP001 = "append-only violation"; AP002 = "redaction shape
-- violation". Both are custom classes (PostgreSQL reserves neither 'AP'), and
-- they are the values to alert on: AP001 in production means something tried
-- to mutate the audit log, which is either an attack or a bug, and either way
-- somebody should look.
CREATE OR REPLACE FUNCTION "audit_event_append_only"() RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
DECLARE
  -- The transaction id this statement is running under. Already assigned by
  -- the time a BEFORE UPDATE/DELETE trigger fires, so this reads it rather
  -- than consuming a new one.
  current_txid text := pg_current_xact_id()::text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- current_setting(..., true) returns NULL on a connection that has never
    -- set the GUC and '' once a SET LOCAL has reverted. Neither equals a
    -- transaction id, so both fall through to the refusal.
    IF current_setting('app.audit_retention_purge', true) = current_txid THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'AuditEvent is append-only: DELETE refused (id=%, action=%)',
      OLD."id", OLD."action"
      USING
        ERRCODE = 'AP001',
        DETAIL  = 'Audit records are append-only under §56. The nightly retention purge is the only path permitted to delete them, and it must claim the purge window inside its own transaction.',
        HINT    = 'Use claimAuditPurgeWindow() from libs/db (SELECT set_config(''app.audit_retention_purge'', pg_current_xact_id()::text, true)) inside the deleting transaction. If you are trying to remove personal data, redact it instead — see claimAuditRedactionWindow().';
  END IF;

  -- TG_OP = 'UPDATE' from here.
  IF current_setting('app.audit_pii_redaction', true) = current_txid THEN
    -- The flag authorises the OPERATION; this check authorises the SHAPE. Both
    -- PII columns must end up NULL and every other column — including columns
    -- added to this table after today — must be byte-identical.
    IF NEW."ipAddress" IS NULL
       AND NEW."userAgent" IS NULL
       AND (to_jsonb(NEW) - 'ipAddress' - 'userAgent')
         = (to_jsonb(OLD) - 'ipAddress' - 'userAgent')
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'AuditEvent redaction may only set "ipAddress" and "userAgent" to NULL (id=%)',
      OLD."id"
      USING
        ERRCODE = 'AP002',
        DETAIL  = 'The PII redaction window permits nulling the two §71 provenance columns and nothing else. Every other column on the row must be unchanged.';
  END IF;

  RAISE EXCEPTION
    'AuditEvent is append-only: UPDATE refused (id=%, action=%)',
    OLD."id", OLD."action"
    USING
      ERRCODE = 'AP001',
      DETAIL  = 'Audit records are append-only under §56. Correcting a past record means writing a new audit row that describes the correction, not editing the old one.',
      HINT    = 'The only permitted update is nulling "ipAddress"/"userAgent" under the PII redaction window — see claimAuditRedactionWindow() in libs/db.';
END;
$fn$;

-- ─── The TRUNCATE guard ──────────────────────────────────────────────────────
--
-- A row-level BEFORE UPDATE OR DELETE trigger does not see TRUNCATE, and
-- TRUNCATE is exactly the shape a "clean up the test data" script takes.
-- TRUNCATE triggers are statement-level only, and this one has nothing to
-- decide: there is no legitimate TRUNCATE of an audit log.
CREATE OR REPLACE FUNCTION "audit_event_no_truncate"() RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION
    'AuditEvent is append-only: TRUNCATE refused'
    USING
      ERRCODE = 'AP001',
      DETAIL  = 'Audit records are append-only under §56. Even the retention purge deletes by predicate, one row at a time, and only the rows its closed operational list permits.';
END;
$fn$;

-- DROP-then-CREATE rather than CREATE OR REPLACE TRIGGER (PostgreSQL 14+) so
-- this file also applies cleanly to a schema adopted from an older cluster.
DROP TRIGGER IF EXISTS "AuditEvent_append_only" ON "AuditEvent";
CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_append_only"();

-- Row-level, not statement-level, on purpose. A statement-level BEFORE DELETE
-- would fire even for a DELETE whose WHERE matches nothing, turning today's
-- harmless no-op `deleteMany` into a hard error. Row-level fires only when
-- there is actually a row about to be destroyed, which is the only case worth
-- refusing.

DROP TRIGGER IF EXISTS "AuditEvent_no_truncate" ON "AuditEvent";
CREATE TRIGGER "AuditEvent_no_truncate"
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_event_no_truncate"();

-- ─── LoginAttempt gets its own clock ─────────────────────────────────────────
--
-- The security log was riding no clock at all: `runPurge` knew about
-- AuditEvent, Notification and JobRun, and "LoginAttempt" — created yesterday
-- by 20260814140000 — grew without bound. It must not ride the AUDIT clock
-- either. The audit window is anchored to the AMLA §9 five-year floor because
-- of what audit rows evidence; a failed-login log evidences something else
-- entirely, is far higher volume, and is nearly all personal data (an IP
-- address and a typed email address per row, most of them belonging to people
-- who are not customers). Those two facts pull the window in opposite
-- directions and a single knob cannot serve both.
--
-- Default 730 days: long enough to reconstruct a slow credential-stuffing
-- campaign that stretches across more than one annual review, short enough
-- that the §71 minimisation argument holds. 0 disables the sweep, which is how
-- a tenant under a regulatory hold freezes it — the same convention the other
-- three knobs already use.
--
-- No trigger on "LoginAttempt", deliberately. See the note on the model in
-- schema.prisma for the argument; in short, the append-only guard is scoped to
-- the table §56 names, and widening it would put a hard failure on the login
-- and erasure paths to protect a table that has exactly one writer and no
-- update path at all.
ALTER TABLE "SystemConfig"
  ADD COLUMN "loginAttemptRetentionDays" INTEGER NOT NULL DEFAULT 730;
