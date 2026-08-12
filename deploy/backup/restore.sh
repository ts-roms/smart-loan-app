#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# restore.sh — restore a Smart Loan backup into a NAMED target.
#
# The inverse of backup.sh, and it takes the same view of what a backup
# is: the Postgres dumps AND the uploads archive. A restore that brings
# back only the database produces rows that reference KYC documents,
# signed agreements and collateral photographs which no longer exist —
# every row intact, every file gone. Hand this script both archives and
# it restores both.
#
# Archive types are dispatched by the filename convention backup.sh
# writes, which is the single source of truth for the layout:
#
#   *-full.sql.gz        → whole database
#   *-platform.sql.gz    → public schema only (platform tables)
#   *-tenant-X.sql.gz    → schema tenant_X only
#   *-uploads.tar.gz     → uploaded files, relative to the uploads root
#
# ── The guard ───────────────────────────────────────────────────────────
#
# The target is an EXPLICIT argument, never inherited from DATABASE_URL.
# The failure this guards against is restoring last night's dump over a
# live database at 3am because the shell had the production URL exported
# — the dumps carry `DROP TABLE`, so that mistake is not recoverable by
# noticing quickly.
#
# Two independent checks, because either can be defeated alone:
#
#   1. Textual — host:port/dbname of the target vs DATABASE_URL. Works
#      with the live database unreachable, which is the state you are
#      actually in during a disaster.
#   2. Cluster identity — current_database() + pg_postmaster_start_time()
#      on both ends. Catches the case the textual check misses, where the
#      same database is spelled two ways (localhost vs 127.0.0.1, a
#      pgbouncer port, a CNAME). Skipped when DATABASE_URL does not
#      answer; that is a real DR event, not a typo.
#
# --force overrides both, and is the documented way to perform a genuine
# production restore. It is deliberately not the default.
#
# The same rule applies to uploads: --uploads-dir must not be the
# configured UPLOADS_DIR unless --force is passed.
#
# ── Idempotence ─────────────────────────────────────────────────────────
#
# Re-running is expected: a drill runs quarterly against the same scratch
# database, and a real restore is often attempted twice. The dumps use
# `--clean --if-exists` so they drop what they are about to create;
# --create tolerates an existing database; tar overwrites in place. There
# is no "already restored" state to clean up first.
#
# Usage:
#   ./restore.sh --target smart_loan_drill --create \
#                /var/backups/smart-loan/daily/20260812T023000-full.sql.gz \
#                /var/backups/smart-loan/daily/20260812T023000-uploads.tar.gz \
#                --uploads-dir /srv/smart-loan/uploads-restored
#
#   ./restore.sh --target postgres://u:p@host/db --force --yes dump.sql.gz
#
# Options:
#   --target DB|URL     REQUIRED. A bare name is resolved against
#                        DATABASE_URL's server; a URL is used as-is.
#   --uploads-dir DIR   where to extract *-uploads.tar.gz
#   --create            CREATE DATABASE if the target does not exist
#   --force             allow the target to be the configured database
#   --yes, -y           skip the confirmation prompt
#
# Required env:
#   DATABASE_URL        the CONFIGURED database. Used to resolve a bare
#                        --target name and as the thing to refuse to
#                        overwrite. Never restored into implicitly.
#
# Optional env:
#   UPLOADS_DIR         the CONFIGURED uploads directory, for the same
#                        refuse-to-overwrite reason.
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

FORCE=false
YES=false
CREATE=false
TARGET=""
RESTORE_UPLOADS_DIR=""
ARCHIVES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:?--target requires a dbname or URL}"; shift 2 ;;
    --uploads-dir) RESTORE_UPLOADS_DIR="${2:?--uploads-dir requires a path}"; shift 2 ;;
    --create) CREATE=true; shift ;;
    --force) FORCE=true; shift ;;
    --yes|-y) YES=true; shift ;;
    --help|-h) sed -n '2,80p' "$0"; exit 0 ;;
    -*) echo "Unknown arg: $1" >&2; exit 2 ;;
    *) ARCHIVES+=("$1"); shift ;;
  esac
done

: "${DATABASE_URL:?DATABASE_URL must be set — it is what the target is checked against}"
CONFIGURED_UPLOADS_DIR="${UPLOADS_DIR:-}"

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 --target <dbname|url> [--create] [--uploads-dir DIR] ARCHIVE..." >&2
  echo "  --target is mandatory. This script never restores into DATABASE_URL by default." >&2
  exit 2
fi
if [[ ${#ARCHIVES[@]} -eq 0 ]]; then
  echo "No archives given. Pass at least one .sql.gz (and optionally an -uploads.tar.gz)." >&2
  exit 2
fi
for a in "${ARCHIVES[@]}"; do
  if [[ ! -f "$a" ]]; then
    echo "Archive not found: $a" >&2
    exit 2
  fi
done

log() {
  echo "[$(date -Iseconds)] $*"
}

# Swap the database name in a libpq URI, preserving credentials, host,
# port and any query string (sslmode, schema, pgbouncer flags).
swap_dbname() {
  local url="$1" db="$2" qs=""
  case "$url" in *\?*) qs="?${url#*\?}"; url="${url%%\?*}" ;; esac
  printf '%s/%s%s' "${url%/*}" "$db" "$qs"
}

# host:port/dbname, lowercased, credentials stripped. Deliberately
# textual: this comparison has to work when the configured database is
# the thing that is down.
url_identity() {
  local u="${1%%\?*}"
  u="${u#*://}"
  u="${u#*@}"
  printf '%s' "$u" | tr '[:upper:]' '[:lower:]'
}

# Database + cluster fingerprint. pg_postmaster_start_time() is unique
# per running cluster and — unlike pg_control_system() — is not
# superuser-restricted, so this works as the ordinary application role.
# Empty string means "did not answer", which callers must treat as
# unknown rather than as a mismatch.
cluster_identity() {
  psql "$1" -At -c \
    "SELECT current_database() || '@' || pg_postmaster_start_time();" \
    2>/dev/null || true
}

# ── Resolve the target ──────────────────────────────────────────────────
case "$TARGET" in
  *://*) TARGET_URL="$TARGET" ;;
  *)     TARGET_URL="$(swap_dbname "$DATABASE_URL" "$TARGET")" ;;
esac
TARGET_DBNAME="${TARGET_URL%%\?*}"
TARGET_DBNAME="${TARGET_DBNAME##*/}"

# ── Guard 1: textual ────────────────────────────────────────────────────
SAME_TEXT=false
if [[ "$(url_identity "$TARGET_URL")" == "$(url_identity "$DATABASE_URL")" ]]; then
  SAME_TEXT=true
fi

# ── Create, if asked, before the cluster check needs to connect ─────────
# Done before guard 2 because a target that does not exist yet cannot be
# fingerprinted — and a target we just created is certainly not the
# configured database.
if [[ "$CREATE" == "true" && "$SAME_TEXT" != "true" ]]; then
  admin_url="$(swap_dbname "$TARGET_URL" postgres)"
  if psql "$admin_url" -At -c \
       "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DBNAME}';" \
       2>/dev/null | grep -q 1; then
    log "target database ${TARGET_DBNAME} already exists — reusing it"
  else
    log "creating database ${TARGET_DBNAME}"
    psql "$admin_url" -q -c "CREATE DATABASE \"${TARGET_DBNAME}\";"
  fi
fi

# ── Guard 2: cluster identity ───────────────────────────────────────────
SAME_CLUSTER=false
TARGET_ID="$(cluster_identity "$TARGET_URL")"
CONFIGURED_ID="$(cluster_identity "$DATABASE_URL")"
if [[ -n "$TARGET_ID" && -n "$CONFIGURED_ID" && "$TARGET_ID" == "$CONFIGURED_ID" ]]; then
  SAME_CLUSTER=true
fi

if [[ "$SAME_TEXT" == "true" || "$SAME_CLUSTER" == "true" ]]; then
  if [[ "$FORCE" != "true" ]]; then
    echo >&2
    echo "REFUSING: --target resolves to the database configured in DATABASE_URL." >&2
    echo "  target:     ${TARGET_URL%%\?*}" >&2
    echo "  configured: ${DATABASE_URL%%\?*}" >&2
    echo "  matched by: $([[ "$SAME_TEXT" == true ]] && printf 'host:port/dbname ')$([[ "$SAME_CLUSTER" == true ]] && printf 'cluster identity')" >&2
    echo >&2
    echo "The dumps contain DROP TABLE. If you really mean to overwrite the live" >&2
    echo "database, pass --force. If you meant to test a restore, pass a scratch" >&2
    echo "name: --target smart_loan_drill --create" >&2
    exit 1
  fi
  log "!! --force: restoring over the CONFIGURED database ${TARGET_DBNAME}"
fi

# ── Classify the archives ───────────────────────────────────────────────
SQL_ARCHIVES=()
UPLOAD_ARCHIVES=()
SCOPES=()
for a in "${ARCHIVES[@]}"; do
  base="$(basename "$a")"
  case "$base" in
    *-uploads.tar.gz) UPLOAD_ARCHIVES+=("$a") ;;
    *-full.sql.gz)      SQL_ARCHIVES+=("$a"); SCOPES+=("$base → full DB") ;;
    *-platform.sql.gz)  SQL_ARCHIVES+=("$a"); SCOPES+=("$base → public schema (platform)") ;;
    *-tenant-*.sql.gz)
      slug="${base#*-tenant-}"; slug="${slug%.sql.gz}"
      SQL_ARCHIVES+=("$a"); SCOPES+=("$base → schema tenant_${slug}")
      ;;
    *.sql.gz)  SQL_ARCHIVES+=("$a"); SCOPES+=("$base → unknown layout, replayed as-is") ;;
    *.tar.gz)  UPLOAD_ARCHIVES+=("$a") ;;
    *) echo "Don't know how to restore: $base" >&2; exit 2 ;;
  esac
done

if [[ ${#UPLOAD_ARCHIVES[@]} -gt 0 && -z "$RESTORE_UPLOADS_DIR" ]]; then
  echo "An uploads archive was given but --uploads-dir was not." >&2
  echo "Refusing to guess where ${#UPLOAD_ARCHIVES[@]} archive(s) of customer documents should land." >&2
  exit 2
fi

# Same principle as the database guard: do not silently overwrite the
# live uploads tree. An extract is not as destructive as DROP TABLE, but
# it does replace files whose only other copy may be the archive you are
# about to restore from.
if [[ -n "$RESTORE_UPLOADS_DIR" && -n "$CONFIGURED_UPLOADS_DIR" && "$FORCE" != "true" ]]; then
  if [[ "$(cd "$RESTORE_UPLOADS_DIR" 2>/dev/null && pwd || echo "$RESTORE_UPLOADS_DIR")" \
        == "$(cd "$CONFIGURED_UPLOADS_DIR" 2>/dev/null && pwd || echo "$CONFIGURED_UPLOADS_DIR")" ]]; then
    echo "REFUSING: --uploads-dir is the configured UPLOADS_DIR (${CONFIGURED_UPLOADS_DIR})." >&2
    echo "Pass --force to overwrite the live uploads tree." >&2
    exit 1
  fi
fi

# ── Plan ────────────────────────────────────────────────────────────────
# A row count on the target is informational, not a refusal. A drill
# restores into the same scratch database every quarter, so "target is
# not empty" is the normal case, and a guard that fires on it would be
# muted within two runs.
EXISTING_TABLES="$(psql "$TARGET_URL" -At -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema');" \
  2>/dev/null || echo '?')"

echo
echo "  Restore plan"
echo "  ────────────"
echo "  Target DB:      ${TARGET_DBNAME}  (${EXISTING_TABLES} existing table(s))"
for s in "${SCOPES[@]}"; do
  echo "  Dump:           $s"
done
for u in "${UPLOAD_ARCHIVES[@]}"; do
  echo "  Uploads:        $(basename "$u") → ${RESTORE_UPLOADS_DIR}"
done
echo "  --force:        $FORCE"
echo

if [[ "$YES" != "true" ]]; then
  read -r -p "Type 'yes' to proceed: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

# ── Restore ─────────────────────────────────────────────────────────────
START="$(date +%s)"

for a in "${SQL_ARCHIVES[@]}"; do
  log "restoring $(basename "$a") into ${TARGET_DBNAME}"
  # ON_ERROR_STOP=1 is load-bearing. Without it psql reports every error
  # and still exits 0, so a truncated or partially-corrupt dump restores
  # "successfully" and the problem surfaces months later as missing rows.
  # It is what caught the pg_dump-version skew on the first drill run.
  # The DROPs in the dump are all IF EXISTS, so an empty target is fine.
  #
  # -o /dev/null discards RESULT SETS only — the dump's search_path
  # set_config() returns a row and would otherwise print a table in the
  # middle of the log. Errors and notices go to stderr and still show.
  gunzip -c "$a" | psql "$TARGET_URL" -v ON_ERROR_STOP=1 --quiet -o /dev/null
done

for a in "${UPLOAD_ARCHIVES[@]}"; do
  log "extracting $(basename "$a") into ${RESTORE_UPLOADS_DIR}"
  mkdir -p "$RESTORE_UPLOADS_DIR"
  # Paths in the archive are relative to the uploads root (backup.sh
  # tars with -C), so this restores into a directory of any name.
  tar -xzf "$a" -C "$RESTORE_UPLOADS_DIR"
  log "   ${RESTORE_UPLOADS_DIR} now holds $(find "$RESTORE_UPLOADS_DIR" -type f | wc -l | tr -d ' ') file(s)"
done

END="$(date +%s)"
log "restore complete in $((END - START))s"
echo
echo "  NOT YET VERIFIED. A restore that ran is not a restore that worked."
echo "  Run the verification:"
echo
echo "    cd libs/db && DATABASE_URL='${TARGET_URL%%\?*}' \\"
echo "      pnpm exec tsx scripts/verify-restore.mjs --verify BASELINE.json"
echo
echo "  See deploy/backup/drill.sh for the whole drill end to end."
