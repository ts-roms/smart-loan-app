#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# drill.sh — the restore drill, end to end, as one command.
#
# §69 asks for a *documented* restore drill. A drill that only exists as
# a numbered list in a document is a drill that gets read and not run;
# the point of putting it in a script is that the next person can type
# one line at 3am, and that the quarterly re-run is a cron entry rather
# than an afternoon.
#
# What it does, in order:
#
#   1. Record a baseline from the SOURCE database — row counts for every
#      table, the five reconciliation checks, and a manifest of the
#      uploads tree. This must happen BEFORE the backup: the baseline is
#      the answer the restore has to reproduce.
#   2. Run backup.sh into a scratch backup directory. The real script,
#      not a simulation of it — a drill that exercises a different code
#      path than the nightly cron proves nothing about the nightly cron.
#   3. Create a scratch database and restore into it with restore.sh.
#      Never over the source: restore.sh refuses that without --force,
#      and this script never passes --force.
#   4. Check migrations — `prisma migrate status` against the restored
#      database. A dump carries _prisma_migrations, so a mismatch here
#      means the dump predates a migration and the application code
#      would fail against it.
#   5. Verify — row counts, reconciliation and the uploads manifest.
#      This is the step that makes it a drill rather than a copy.
#   6. Print the wall-clock time. Step 3 to step 5 is the measured RTO
#      for the data layer; anything else is an estimate.
#
# The scratch database and backup directory are dropped at the end
# unless --keep is passed.
#
# Usage:
#   DATABASE_URL=postgres://loan:loan@localhost:5433/smart_loan \
#   UPLOADS_DIR=./uploads \
#     bash deploy/backup/drill.sh
#
#   bash deploy/backup/drill.sh --scratch-db smart_loan_drill --keep
#
# Options:
#   --scratch-db NAME   throwaway database name (default smart_loan_drill)
#   --backup-dir DIR    where the drill's dumps go (default: a temp dir)
#   --uploads-dir DIR   source uploads tree (default: $UPLOADS_DIR)
#   --keep              leave the scratch DB, dumps and restored uploads
#                        in place for inspection
#
# Required env:
#   DATABASE_URL        the SOURCE database. Read only — the drill takes
#                        a dump from it and never writes to it.
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRATCH_DB="smart_loan_drill"
BACKUP_DIR_ARG=""
SOURCE_UPLOADS="${UPLOADS_DIR:-}"
KEEP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scratch-db) SCRATCH_DB="${2:?--scratch-db requires a name}"; shift 2 ;;
    --backup-dir) BACKUP_DIR_ARG="${2:?--backup-dir requires a path}"; shift 2 ;;
    --uploads-dir) SOURCE_UPLOADS="${2:?--uploads-dir requires a path}"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --help|-h) sed -n '2,50p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

: "${DATABASE_URL:?DATABASE_URL must be set — the drill dumps FROM it}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

WORK="${BACKUP_DIR_ARG:-$(mktemp -d "${TMPDIR:-/tmp}/smart-loan-drill.XXXXXX")}"
mkdir -p "$WORK"
BASELINE="$WORK/baseline.json"
RESTORED_UPLOADS="$WORK/uploads-restored"

log()  { echo "[$(date -Iseconds)] $*"; }
step() { echo; echo "══ $* ═══════════════════════════════════════════"; }

cleanup() {
  if [[ "$KEEP" == "true" ]]; then
    echo
    log "--keep: leaving ${WORK} and database ${SCRATCH_DB} in place"
    return
  fi
  log "dropping scratch database ${SCRATCH_DB}"
  # FORCE terminates any leftover connection (Prisma's pool from the
  # verification step). Without it the DROP blocks and the drill hangs
  # on its own tidy-up, which is a silly way to fail.
  psql "${DATABASE_URL%/*}/postgres" -q -c \
    "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\" WITH (FORCE);" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

DRILL_START="$(date +%s)"

# ── 1. Baseline ─────────────────────────────────────────────────────────
step "1/5  Baseline from the source database"
baseline_args=(--record "$BASELINE")
if [[ -n "$SOURCE_UPLOADS" && -d "$SOURCE_UPLOADS" ]]; then
  baseline_args+=(--uploads "$SOURCE_UPLOADS")
else
  # Said out loud rather than skipped quietly. A drill that never looked
  # at the files cannot claim the KYC documents came back, and that is
  # precisely the gap §69 flagged.
  log "!! no uploads tree (UPLOADS_DIR='${SOURCE_UPLOADS}') — the drill will NOT prove files survive"
fi
# `cd libs/db && pnpm exec` rather than `pnpm --filter @loan/db exec`:
# the filtered form swallows the child's exit code and reports
# ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL / "Command tsx not found" instead,
# which sends whoever is reading the drill output hunting a missing
# dependency that is installed.
(cd "$REPO_ROOT/libs/db" && DATABASE_URL="$DATABASE_URL" \
  pnpm exec tsx scripts/verify-restore.mjs "${baseline_args[@]}")

# ── 2. Backup ───────────────────────────────────────────────────────────
step "2/5  Backup (the real backup.sh)"
BACKUP_START="$(date +%s)"
BACKUP_DIR="$WORK/backups" UPLOADS_DIR="$SOURCE_UPLOADS" \
  bash "$HERE/backup.sh"
BACKUP_END="$(date +%s)"

mapfile -t DUMPS < <(ls -1t "$WORK"/backups/daily/*.sql.gz 2>/dev/null || true)
if [[ ${#DUMPS[@]} -eq 0 ]]; then
  echo "backup.sh produced no dumps — nothing to restore. Stopping." >&2
  exit 1
fi
mapfile -t UPLOAD_ARCHIVES < <(ls -1t "$WORK"/backups/daily/*-uploads.tar.gz 2>/dev/null || true)

# ── 3. Restore ──────────────────────────────────────────────────────────
step "3/5  Restore into scratch database ${SCRATCH_DB}"
RESTORE_START="$(date +%s)"
restore_args=(--target "$SCRATCH_DB" --create --yes)
if [[ ${#UPLOAD_ARCHIVES[@]} -gt 0 ]]; then
  restore_args+=(--uploads-dir "$RESTORED_UPLOADS")
fi
# Note the absence of --force. If DATABASE_URL and the scratch name ever
# resolve to the same database, this drill must fail loudly rather than
# restore over the source it just dumped.
#
# Both archive kinds go in. The first run of this drill passed only the
# dumps, and the restore reported success having touched no files at all
# — which is the exact shape of the failure the uploads backup was added
# to prevent, reproduced in the thing meant to catch it.
UPLOADS_DIR="$SOURCE_UPLOADS" bash "$HERE/restore.sh" "${restore_args[@]}" \
  "${DUMPS[@]}" ${UPLOAD_ARCHIVES[@]+"${UPLOAD_ARCHIVES[@]}"}
RESTORE_END="$(date +%s)"

SCRATCH_URL="${DATABASE_URL%/*}/${SCRATCH_DB}"

# ── 4. Migrations ───────────────────────────────────────────────────────
step "4/5  Migration status on the restored database"
# Non-fatal on its own: `migrate status` exits non-zero for "database
# schema is not up to date", which is a finding to report, not a reason
# to abandon the verification that follows.
(cd "$REPO_ROOT/libs/db" && DATABASE_URL="$SCRATCH_URL" \
  pnpm exec prisma migrate status) || log "!! migrate status reported a problem — see above"

# ── 5. Verify ───────────────────────────────────────────────────────────
step "5/5  Verification"
verify_args=(--verify "$BASELINE")
if [[ -d "$RESTORED_UPLOADS" ]]; then
  verify_args+=(--uploads "$RESTORED_UPLOADS")
fi
VERIFY_START="$(date +%s)"
VERIFIED=true
(cd "$REPO_ROOT/libs/db" && DATABASE_URL="$SCRATCH_URL" \
  pnpm exec tsx scripts/verify-restore.mjs "${verify_args[@]}") || VERIFIED=false
VERIFY_END="$(date +%s)"

DRILL_END="$(date +%s)"

# ── Report ──────────────────────────────────────────────────────────────
step "Drill result"
echo "  backup      $((BACKUP_END - BACKUP_START))s"
echo "  restore     $((RESTORE_END - RESTORE_START))s"
echo "  verify      $((VERIFY_END - VERIFY_START))s"
echo "  ─────────────────────"
echo "  RTO (data)  $((VERIFY_END - RESTORE_START))s   restore → verified"
echo "  total       $((DRILL_END - DRILL_START))s   including the baseline and the backup"
echo
if [[ "$VERIFIED" == "true" ]]; then
  echo "  PASS — the backup restores and the restored book reconciles."
  exit 0
fi
echo "  FAIL — see the verification output above. Do not treat the nightly" >&2
echo "         backup as a working backup until this passes." >&2
exit 1
