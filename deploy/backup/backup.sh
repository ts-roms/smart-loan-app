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
    --exclude "*" --include "*.sql.gz"
fi

# ── Rotate ──────────────────────────────────────────────────────────────
log "rotating daily/ (keep ${KEEP_DAYS} days)"
find "$BACKUP_DIR/daily" -name "*.sql.gz" -type f -mtime "+${KEEP_DAYS}" -delete

log "rotating weekly/ (keep ${KEEP_WEEKS} weeks)"
# Weeks → ${KEEP_WEEKS} × 7 days. Conservative upper bound on disk use:
# (KEEP_DAYS + KEEP_WEEKS × 7) × dump-size.
find "$BACKUP_DIR/weekly" -name "*.sql.gz" -type f \
  -mtime "+$((KEEP_WEEKS * 7))" -delete

END="$(date +%s)"
log "done in $((END - START))s — wrote ${#PRODUCED[@]} dump(s)"
