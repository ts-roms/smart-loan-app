#!/usr/bin/env bash
# SmartLoan bare-metal installer.
#
# Sets up an on-prem SmartLoan install on a fresh Linux host without
# Docker. Useful when the cooperative's IT shop doesn't run containers
# and would rather have a regular systemd service.
#
# Tested on Ubuntu 22.04 LTS / 24.04 LTS. Other distros work but may
# need package-name tweaks (the `apt-get` call below).
#
# Idempotent: rerun is safe. Skips steps that have already been done.
#
# Usage:
#   sudo ./install.sh [--source-dir /opt/smartloan] [--db-url URL]
#
# Most settings come from prompts the first time; subsequent runs use
# the values written to /etc/smartloan/smartloan.env. To change a
# value later, edit that file and run `systemctl restart smartloan-api`.

set -euo pipefail

# ─── Defaults ──────────────────────────────────────────────────────────

SOURCE_DIR="${SOURCE_DIR:-/opt/smartloan}"
ENV_DIR="${ENV_DIR:-/etc/smartloan}"
ENV_FILE="${ENV_DIR}/smartloan.env"
SERVICE_USER="${SERVICE_USER:-smartloan}"
WEB_PORT="${WEB_PORT:-8080}"
API_PORT="${API_PORT:-3001}"
NODE_VERSION_MIN=20

# ─── CLI args (override defaults) ──────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    --db-url)     DATABASE_URL_OVERRIDE="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Output helpers ────────────────────────────────────────────────────

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
step()  { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }

# ─── Preflight ─────────────────────────────────────────────────────────

require_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "This script needs to run as root (sudo). It writes to /etc, /opt, and creates a systemd unit."
  fi
}

check_os() {
  if [[ ! -f /etc/os-release ]]; then
    fail "Can't detect OS — /etc/os-release missing. This installer is only tested on Ubuntu / Debian-family distros."
  fi
  . /etc/os-release
  case "$ID" in
    ubuntu|debian) ok "OS: $PRETTY_NAME" ;;
    *)
      warn "OS is $PRETTY_NAME — installer was written for Debian/Ubuntu. Proceeding, but package names may not match. Press Ctrl-C to abort, Enter to continue."
      read -r
      ;;
  esac
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local v
  v=$(node -v | sed 's/^v//' | cut -d. -f1)
  [[ "$v" -ge "$NODE_VERSION_MIN" ]]
}

check_pg() {
  command -v psql >/dev/null 2>&1
}

# ─── Steps ─────────────────────────────────────────────────────────────

install_node() {
  step "Node.js ($NODE_VERSION_MIN+)"
  if check_node; then
    ok "Already installed: $(node -v)"
    return
  fi
  warn "Installing via NodeSource — replaces any older 'nodejs' package"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  ok "Installed: $(node -v)"
}

install_pnpm() {
  step "pnpm (via corepack)"
  if command -v pnpm >/dev/null 2>&1; then
    ok "Already installed: $(pnpm --version)"
    return
  fi
  corepack enable
  corepack prepare pnpm@9.15.0 --activate
  ok "Installed: $(pnpm --version)"
}

install_postgres() {
  step "PostgreSQL 16"
  if check_pg; then
    ok "Already installed: $(psql --version | head -1)"
    return
  fi
  apt-get install -y postgresql postgresql-contrib
  systemctl enable --now postgresql
  ok "Installed + started"
}

create_service_user() {
  step "Service user '$SERVICE_USER'"
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    ok "Already exists"
    return
  fi
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "Created"
}

create_db() {
  step "Database"
  local db_name="smart_loan"
  local db_user="loan"
  local existing
  existing=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$db_name'" 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    ok "Database '$db_name' already exists"
    return
  fi
  if [[ -z "${DB_PASSWORD:-}" ]]; then
    DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
    warn "Generated random DB password — recorded in $ENV_FILE"
  fi
  sudo -u postgres psql <<SQL
CREATE DATABASE $db_name;
CREATE USER $db_user WITH ENCRYPTED PASSWORD '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON DATABASE $db_name TO $db_user;
ALTER DATABASE $db_name OWNER TO $db_user;
SQL
  DATABASE_URL="postgres://$db_user:$DB_PASSWORD@localhost:5432/$db_name"
  ok "Created '$db_name', user '$db_user'"
}

place_source() {
  step "Source tree at $SOURCE_DIR"
  if [[ -d "$SOURCE_DIR/.git" || -f "$SOURCE_DIR/pnpm-workspace.yaml" ]]; then
    ok "Already present"
  else
    # Common case: script is shipped INSIDE the repo. Copy the tree
    # we're sitting in to $SOURCE_DIR.
    local repo_root
    repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
    if [[ -f "$repo_root/pnpm-workspace.yaml" ]]; then
      mkdir -p "$SOURCE_DIR"
      # rsync would be ideal but we don't want to depend on it. cp -a
      # preserves perms and is in coreutils.
      cp -a "$repo_root/." "$SOURCE_DIR/"
      ok "Copied from $repo_root"
    else
      fail "$SOURCE_DIR is empty and the installer doesn't appear to live inside a SmartLoan repo. Extract the install bundle to $SOURCE_DIR first, then re-run."
    fi
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$SOURCE_DIR"
}

install_deps() {
  step "Workspace dependencies"
  sudo -u "$SERVICE_USER" -H bash -c "cd '$SOURCE_DIR' && pnpm install --frozen-lockfile"
  ok "pnpm install complete"
  sudo -u "$SERVICE_USER" -H bash -c "cd '$SOURCE_DIR' && pnpm --filter @loan/db prisma:generate"
  ok "Prisma client generated"
}

write_env() {
  step "Environment file ($ENV_FILE)"
  mkdir -p "$ENV_DIR"
  if [[ -f "$ENV_FILE" ]]; then
    ok "Already exists — leaving as-is (edit by hand to change)"
    return
  fi
  local jwt_secret
  jwt_secret=$(openssl rand -base64 48 | tr -d '\n')
  cat > "$ENV_FILE" <<EOF
# SmartLoan production environment.
# Generated by deploy/bare-metal/install.sh on $(date -Iseconds).
# Edit then \`systemctl restart smartloan-api\` to apply.

DATABASE_URL=${DATABASE_URL_OVERRIDE:-${DATABASE_URL}}
JWT_SECRET=${jwt_secret}
PORT=${API_PORT}
HOST=127.0.0.1
WEB_ORIGIN=http://localhost:${WEB_PORT}
NODE_ENV=production

# Branding — override after install via Settings → Branding in the app.
COMPANY_NAME=SmartLoan
TOTP_ISSUER=SmartLoan

# Storage. Defaults under $SOURCE_DIR — change if you have a larger
# disk mounted elsewhere.
UPLOADS_DIR=${SOURCE_DIR}/uploads

# Licensing — paste your vendor public key in ONE of these. License
# activation will fail without it.
LICENSE_PUBLIC_KEY_PEM=
LICENSE_PUBLIC_KEY_PATH=

# Providers — leave as MOCK until you have real creds set up.
NOTIFICATION_PROVIDER=MOCK
PAYMENT_PROVIDER=MOCK
AML_PROVIDER=MOCK

# Optional
SENTRY_DSN=
OLLAMA_URL=
OLLAMA_MODEL=phi3:mini
EOF
  chmod 600 "$ENV_FILE"
  chown root:"$SERVICE_USER" "$ENV_FILE"
  ok "Written (chmod 600, owned by root:$SERVICE_USER)"
  warn "Edit $ENV_FILE and paste your LICENSE_PUBLIC_KEY_PEM before activating a license."
}

run_migrations() {
  step "Database migrations"
  sudo -u "$SERVICE_USER" -H env "$(grep -v '^#' "$ENV_FILE" | xargs)" \
    bash -c "cd '$SOURCE_DIR' && pnpm --filter @loan/db exec prisma migrate deploy"
  ok "Schema up to date"
}

run_seed_if_empty() {
  step "Bootstrap seed (first install only)"
  local user_count
  user_count=$(sudo -u postgres psql -tAc 'SELECT count(*) FROM "User"' smart_loan 2>/dev/null || echo "0")
  if [[ "$user_count" != "0" ]]; then
    ok "Skipping — database already has $user_count user(s)"
    return
  fi
  sudo -u "$SERVICE_USER" -H env "$(grep -v '^#' "$ENV_FILE" | xargs)" \
    bash -c "cd '$SOURCE_DIR' && pnpm --filter @loan/db prisma:seed"
  warn "Seed complete — check the output above for the bootstrap admin password and change it immediately on first login."
}

build_web() {
  step "Build tenant web app"
  sudo -u "$SERVICE_USER" -H bash -c "cd '$SOURCE_DIR' && pnpm --filter @loan/web build"
  ok "apps/web/dist/ ready"
}

install_systemd_unit() {
  step "systemd unit (smartloan-api.service)"
  local unit_src
  unit_src="$(dirname "$0")/systemd/smartloan-api.service"
  if [[ ! -f "$unit_src" ]]; then
    fail "Missing unit template at $unit_src — installer is incomplete."
  fi
  # Template substitution: replace the @@TOKENS@@ in the unit file.
  sed \
    -e "s|@@SOURCE_DIR@@|$SOURCE_DIR|g" \
    -e "s|@@ENV_FILE@@|$ENV_FILE|g" \
    -e "s|@@SERVICE_USER@@|$SERVICE_USER|g" \
    "$unit_src" > /etc/systemd/system/smartloan-api.service
  systemctl daemon-reload
  systemctl enable smartloan-api.service
  systemctl restart smartloan-api.service
  ok "Service enabled + (re)started"
}

print_next_steps() {
  cat <<EOF

$(bold "Install complete.")

API:     http://localhost:${API_PORT}/api/v1/health
Web:     served by your reverse proxy — point it at $SOURCE_DIR/apps/web/dist
         (see deploy/bare-metal/nginx/smartloan.conf.example for a starter)

What's next:
  1. Edit $ENV_FILE and paste your LICENSE_PUBLIC_KEY_PEM
  2. systemctl restart smartloan-api
  3. Set up your reverse proxy (nginx/Caddy) and point your DNS at it
  4. Visit the web URL and sign in with the bootstrap admin shown above
  5. Settings → License → paste your vendor-issued license token

Service control:
  systemctl status smartloan-api
  systemctl restart smartloan-api
  journalctl -u smartloan-api -f

EOF
}

# ─── Main ──────────────────────────────────────────────────────────────

require_root
check_os
install_node
install_pnpm
install_postgres
create_service_user
create_db
place_source
install_deps
write_env
run_migrations
run_seed_if_empty
build_web
install_systemd_unit
print_next_steps
