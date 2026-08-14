#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# backup.sh — scheduled Postgres backup for Smart Loan deployments.
#
# Single script, two modes (selected by MULTI_TENANT env):
#
#   - MULTI_TENANT != true  → dumps the whole DB (one file per night)
#   - MULTI_TENANT == true  → dumps public.* + each tenant schema
#                              separately so restoring a single tenant
#                              doesn't require restoring everything
#
# Rotation: keeps N days of full backups, M weeks of weekly backups.
# Names are timestamped so the rotation logic is purely
# filename-based; no metadata file to keep in sync with reality.
#
# Storage: writes to ${BACKUP_DIR:-/var/backups/smart-loan/}. A
# follow-up `s3 sync` (off by default — see BACKUP_S3_BUCKET) ships
# the files off-host.
#
# Usage:
#   ./backup.sh                                 # run nightly via cron
#   BACKUP_S3_BUCKET=s3://my-bucket ./backup.sh # nightly + offsite
#   ./backup.sh --tenant acme-coop              # one-shot ad-hoc
#
# Required env:
#   DATABASE_URL          libpq URI for the platform connection
#   MULTI_TENANT          "true" to enable per-tenant dump mode
#
# Optional env:
#   BACKUP_DIR            local directory (default /var/backups/smart-loan)
#   UPLOADS_DIR           directory holding uploaded files. When set and
#                          present, each run also archives it.
#   STORAGE_DRIVER        when "S3", uploads live in a bucket and this
#                          script does NOT back them up — it says so
#                          loudly. Bucket versioning + replication are
#                          the operator's job; durability is not a backup.
#   BACKUP_KEEP_DAYS      daily retention (default 14)
#   BACKUP_KEEP_WEEKS     weekly retention (default 8) — Sunday dumps
#                          are also tagged "weekly" and kept longer
#   BACKUP_S3_BUCKET      e.g. s3://acme-backups/smart-loan
#   BACKUP_S3_ENDPOINT    custom S3 endpoint (DigitalOcean Spaces,
#                          MinIO, R2, etc.). Set with AWS_* creds.
#
# Cron line example (root crontab, 02:30 daily):
#   30 2 * * *  /opt/smart-loan/deploy/backup/backup.sh \
#                  >> /var/log/smart-loan-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Args ────────────────────────────────────────────────────────────────
SLUG_ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tenant)
      SLUG_ONLY="${2:?--tenant requires a slug}"
      shift 2
      ;;
    --help|-h)
      sed -n '2,50p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ── Config ──────────────────────────────────────────────────────────────
: "${DATABASE_URL:?DATABASE_URL must be set}"
MULTI_TENANT="${MULTI_TENANT:-false}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/smart-loan}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
KEEP_WEEKS="${BACKUP_KEEP_WEEKS:-8}"
UPLOADS_DIR="${UPLOADS_DIR:-}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
TS="$(date +%Y%m%dT%H%M%S)"
DOW="$(date +%u)" # 1=Mon, 7=Sun — we keep Sun dumps in /weekly

log() {
  echo "[$(date -Iseconds)] $*"
}

# Use psql to list active tenant slugs. Single query, ACTIVE only —
# ARCHIVED tenants are retained but don't need nightly dumps. The
# `--csv -t` combo gives one slug per line with no header.
list_tenant_slugs() {
  psql "$DATABASE_URL" -At -c \
    'SELECT slug FROM public."Tenant" WHERE status != '\''ARCHIVED'\'';' 2>/dev/null \
    || true
}

# Warn when pg_dump is a newer major than the server it is dumping.
#
# Found by the restore drill on 12 Aug 2026, and it is a nastier failure
# than it sounds: pg_dump 18 dumping a 16 server emits a header
# containing `SET transaction_timeout = 0;`, a GUC that did not exist
# before 17. The dump completes, the file looks right, gzip is happy —
# and every attempt to replay it into a 16 server dies on line 9 with
# "unrecognized configuration parameter". A backup that cannot be
# restored into a server of the version you are running is not a backup,
# and nothing in the backup path noticed for as long as nobody tried.
#
# A warning rather than a hard failure: a dump taken with a mismatched
# client is still worth more than no dump at all, and refusing here
# would silently take out a nightly job over what is usually a packaging
# untidiness. Fix it by installing client tools matching the server's
# major version, then re-run drill.sh to confirm.
warn_on_version_skew() {
  local client server
  client="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
  server="$(psql "$DATABASE_URL" -At -c 'SHOW server_version_num;' 2>/dev/null || echo '')"
  [[ -z "$server" ]] && return 0
  server=$((server / 10000))
  if [[ "$client" != "$server" ]]; then
    log "!! pg_dump is ${client}.x but the server is ${server}.x"
    log "!! a dump from a NEWER client may not replay into a ${server}.x server — see docs/modernization/disaster-recovery.md"
  fi
}

# Run pg_dump for one Postgres schema → one file under daily/. Returns
# the file path on stdout for the caller to pick up.
dump_schema() {
  local schema="$1"
  local label="$2"
  local target="$BACKUP_DIR/daily/${TS}-${label}.sql.gz"
  log "→ dumping schema ${schema} to ${target}"
  pg_dump \
    --schema="$schema" \
    --no-owner --no-acl \
    --clean --if-exists \
    "$DATABASE_URL" \
    | gzip -c > "$target"
  echo "$target"
}

# ── Run ─────────────────────────────────────────────────────────────────
START="$(date +%s)"
PRODUCED=()

warn_on_version_skew

if [[ -n "$SLUG_ONLY" ]]; then
  log "ad-hoc dump for tenant ${SLUG_ONLY}"
  PRODUCED+=("$(dump_schema "tenant_${SLUG_ONLY}" "tenant-${SLUG_ONLY}")")
elif [[ "$MULTI_TENANT" == "true" ]]; then
  log "multi-tenant mode: dumping public + each active tenant schema"
  PRODUCED+=("$(dump_schema public platform)")
  while IFS= read -r slug; do
    [[ -z "$slug" ]] && continue
    PRODUCED+=("$(dump_schema "tenant_${slug}" "tenant-${slug}")")
  done < <(list_tenant_slugs)
else
  log "single-tenant mode: dumping the whole DB"
  target="$BACKUP_DIR/daily/${TS}-full.sql.gz"
  log "→ dumping all schemas to ${target}"
  pg_dump --no-owner --no-acl --clean --if-exists "$DATABASE_URL" \
    | gzip -c > "$target"
  PRODUCED+=("$target")
fi

# ── Uploaded files ──────────────────────────────────────────────────────
#
# The dumps above cover Postgres. Uploaded files do NOT live in Postgres —
# KYC documents, signed loan agreements and collateral photographs are on
# a filesystem, and the database only holds their paths. Without this
# step a restore produces a database referencing documents that no longer
# exist: every row intact, every file gone.
#
# ── When STORAGE_DRIVER=S3, this script does NOT cover uploads ──
#
# Roadmap 3.1 made the storage backend swappable. Local disk is still the
# default and everything below works exactly as it did. But once uploads
# are addressed to a bucket, the local directory is empty or stale, and
# tarring it produces a backup that LOOKS successful and restores
# nothing. That is worse than no backup, so the S3 case is called out
# loudly rather than skipped quietly.
#
# The old comment here claimed object storage "has its own replication"
# and needed no backup. That is half right and the dangerous half:
# S3-class durability protects against hardware failure, NOT against a
# deletion, an application bug, a ransomware event or a bad migration —
# all of which replicate faithfully to every copy. Uploads in a bucket
# need bucket versioning plus either a lifecycle policy or cross-region
# replication, configured on the bucket. None of that is this script's
# job, and none of it happens by default.
STORAGE_DRIVER_UPPER="$(printf '%s' "${STORAGE_DRIVER:-}" | tr '[:lower:]' '[:upper:]')"

if [[ "$STORAGE_DRIVER_UPPER" == "S3" ]]; then
  log "!! STORAGE_DRIVER=S3 — uploaded files are in a bucket and are NOT covered by this script"
  log "!! ensure bucket versioning + replication are enabled; object durability is not a backup"
  if [[ -n "$UPLOADS_DIR" && -d "$UPLOADS_DIR" ]]; then
    # Both configured at once. Archive it anyway — it may hold files
    # written before the switch — but do not let it read as coverage.
    uploads_target="$BACKUP_DIR/daily/${TS}-uploads-legacy.tar.gz"
    log "→ archiving PRE-MIGRATION uploads from ${UPLOADS_DIR} to ${uploads_target}"
    log "!! this archive covers only files written before STORAGE_DRIVER=S3 was set"
    tar -czf "$uploads_target" -C "$UPLOADS_DIR" .
    PRODUCED+=("$uploads_target")
  fi
elif [[ -n "$UPLOADS_DIR" ]]; then
  if [[ -d "$UPLOADS_DIR" ]]; then
    uploads_target="$BACKUP_DIR/daily/${TS}-uploads.tar.gz"
    log "→ archiving uploads from ${UPLOADS_DIR} to ${uploads_target}"
    # -C so the archive holds paths relative to the uploads root, which
    # makes it restorable into a directory of a different name.
    tar -czf "$uploads_target" -C "$UPLOADS_DIR" .
    PRODUCED+=("$uploads_target")
  else
    # Loud, not silent. A configured-but-missing uploads directory is far
    # more likely to be a wrong path than a deliberate absence, and a
    # backup that quietly skips the files is worse than one that fails.
    log "!! UPLOADS_DIR is set to ${UPLOADS_DIR} but that directory does not exist — NOT backing up uploads"
  fi
fi

# ── Promote Sunday → weekly ─────────────────────────────────────────────
if [[ "$DOW" == "7" ]]; then
  log "Sunday — copying daily dumps to weekly/"
  for f in "${PRODUCED[@]}"; do
    base="$(basename "$f")"
    cp "$f" "$BACKUP_DIR/weekly/$base"
  done
fi

# ── Off-site sync ───────────────────────────────────────────────────────
if [[ -n "$S3_BUCKET" ]]; then
  log "syncing to ${S3_BUCKET}"
  endpoint_args=()
  if [[ -n "$S3_ENDPOINT" ]]; then
    endpoint_args+=(--endpoint-url "$S3_ENDPOINT")
  fi
  aws s3 sync "$BACKUP_DIR" "$S3_BUCKET" \
    "${endpoint_args[@]}" \
    --no-progress \
    --exclude "*" --include "*.sql.gz" --include "*.tar.gz"
fi

# ── Rotate ──────────────────────────────────────────────────────────────
log "rotating daily/ (keep ${KEEP_DAYS} days)"
find "$BACKUP_DIR/daily" \( -name "*.sql.gz" -o -name "*.tar.gz" \)   -type f -mtime "+${KEEP_DAYS}" -delete

log "rotating weekly/ (keep ${KEEP_WEEKS} weeks)"
# Weeks → ${KEEP_WEEKS} × 7 days. Conservative upper bound on disk use:
# (KEEP_DAYS + KEEP_WEEKS × 7) × dump-size.
find "$BACKUP_DIR/weekly" -name "*.sql.gz" -type f \
  -mtime "+$((KEEP_WEEKS * 7))" -delete

END="$(date +%s)"
log "done in $((END - START))s — wrote ${#PRODUCED[@]} dump(s)"
