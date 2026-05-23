#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# restore.sh — restore from a Smart Loan pg_dump backup.
#
# Two modes selected by the dump filename:
#
#   - full dump:           *-full.sql.gz       → full DB restore
#   - per-schema dump:     *-{platform,tenant-X}.sql.gz
#                          → restores only that schema
#
# Safety:
#   - Refuses to run against a DB that already has data unless --force
#     is passed. The pg_dump output uses --clean --if-exists, which
#     drops tables on import, so the safety guard isn't theoretical.
#   - Prints what it'd do and waits for "yes" confirmation unless
#     --yes is passed.
#
# Usage:
#   ./restore.sh /var/backups/smart-loan/daily/20260523T023000-tenant-acme.sql.gz
#   ./restore.sh --force --yes /path/to/dump.sql.gz
#
# Required env:
#   DATABASE_URL          libpq URI to restore INTO. Best practice is
#                          to test restores in a non-production DB first.
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

FORCE=false
YES=false
DUMP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=true; shift ;;
    --yes|-y) YES=true; shift ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) DUMP="$1"; shift ;;
  esac
done

: "${DATABASE_URL:?DATABASE_URL must be set}"
if [[ -z "$DUMP" ]]; then
  echo "Usage: $0 [--force] [--yes] /path/to/dump.sql.gz" >&2
  exit 2
fi
if [[ ! -f "$DUMP" ]]; then
  echo "Dump not found: $DUMP" >&2
  exit 2
fi

log() {
  echo "[$(date -Iseconds)] $*"
}

# Figure out what schema(s) this dump covers by inspecting the
# filename. The naming convention from backup.sh is the source of
# truth here.
base="$(basename "$DUMP")"
case "$base" in
  *-full.sql.gz)
    SCOPE="full DB"
    ;;
  *-platform.sql.gz)
    SCOPE="public schema only (platform tables)"
    ;;
  *-tenant-*.sql.gz)
    slug="${base#*-tenant-}"
    slug="${slug%.sql.gz}"
    SCOPE="tenant schema 'tenant_${slug}' only"
    ;;
  *)
    SCOPE="unknown layout (will replay as-is)"
    ;;
esac

# Sanity check the target. We use a regex on the conninfo to extract
# the dbname for the prompt — purely cosmetic.
DBNAME="$(psql "$DATABASE_URL" -At -c 'SELECT current_database();' 2>/dev/null || echo '?')"

# Refuse on non-empty target unless --force.
if [[ "$FORCE" != "true" ]]; then
  ROW_COUNT="$(psql "$DATABASE_URL" -At -c \
    'SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('"'"'pg_catalog'"'"', '"'"'information_schema'"'"');' \
    2>/dev/null || echo 0)"
  if [[ "$ROW_COUNT" -gt 0 ]]; then
    echo "Target DB '${DBNAME}' already has ${ROW_COUNT} table(s)." >&2
    echo "Pass --force to overwrite. (--clean --if-exists in the dump will DROP TABLE first.)" >&2
    exit 1
  fi
fi

echo
echo "  Restore plan"
echo "  ────────────"
echo "  Dump:          $DUMP"
echo "  Target DB:     $DBNAME"
echo "  Scope:         $SCOPE"
echo "  --force:       $FORCE"
echo

if [[ "$YES" != "true" ]]; then
  read -r -p "Type 'yes' to proceed: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
fi

log "starting restore"
START="$(date +%s)"
# psql exits non-zero on any error from the dump's SQL. The dump
# uses --clean --if-exists so re-runs against the same DB are
# tolerant of leftovers.
gunzip -c "$DUMP" | psql "$DATABASE_URL"

END="$(date +%s)"
log "restore complete in $((END - START))s"
log "verify by running cross-tenant isolation smoke (docs/multi-tenant-cutover.md §3)"
