#!/usr/bin/env bash
#
# Automated smoke test — exercises the API end to end against a running
# stack. Complements customer-flows.md, which is the manual UI checklist;
# this covers the things worth asserting on every change and which are
# tedious to click through.
#
# What it checks
#   auth          missing / malformed / alg:none-forged tokens are rejected
#   RBAC          staff reach their surfaces, and are denied the ones they
#                 shouldn't reach
#   picker        hasLoans / hasDefaulted across all three ranking tiers
#   DORSI         an officer can run the screen but cannot tag or approve
#   payments      provider selection, and the sandbox intent -> paid flow
#   amortization  a quoted schedule reconciles to the principal exactly
#
# Prerequisites
#   pnpm dev:up       database up, migrated, seeded
#   pnpm dev:license  ACTIVATE A LICENSE. DORSI and other features sit
#                     behind the licence gate and return 402 without one,
#                     which looks exactly like an authorisation failure.
#   pnpm dev          API on :3001
#
# Usage
#   pnpm e2e
#   API_URL=https://staging.example/api/v1 pnpm e2e
#
# DEV ONLY. It reseeds the PICKER-* fixtures (deleting any existing ones)
# and records a real payment against a fixture loan. Never point it at
# anything you care about.

set -uo pipefail

API=${API_URL:-http://localhost:3001/api/v1}
PASSWORD=${SMOKE_PASSWORD:-P@ssw0rd123}
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
HERE=$(cd "$(dirname "$0")" && pwd)

pass=0
fail=0
green() { printf "\033[32m%s\033[0m" "$1"; }
red() { printf "\033[31m%s\033[0m" "$1"; }

login() {
  curl -s -X POST "$API/auth/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}" |
    node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8')).token}catch(e){''}"
}

# code <expected> <label> <curl args...>
code() {
  local want=$1 label=$2
  shift 2
  local got
  got=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  if [ "$got" = "$want" ]; then
    printf "  %s %-52s %s\n" "$(green PASS)" "$label" "$got"
    pass=$((pass + 1))
  else
    printf "  %s %-52s got %s want %s\n" "$(red FAIL)" "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

# check <label> <actual> <expected>
check() {
  if [ "$2" = "$3" ]; then
    printf "  %s %-52s %s\n" "$(green PASS)" "$1" "$2"
    pass=$((pass + 1))
  else
    printf "  %s %-52s got '%s' want '%s'\n" "$(red FAIL)" "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

# ── preflight ─────────────────────────────────────────────────────────

if ! curl -s -o /dev/null --max-time 5 "$API/customers"; then
  echo "$(red 'API unreachable') at $API — run 'pnpm dev' first." >&2
  exit 1
fi

echo "── setup: reseeding fixtures ─────────────────────────────────────"
if (cd "$ROOT" && pnpm --filter @loan/db exec dotenv -e ../../.env -- \
  tsx "$HERE/fixtures.ts" >/dev/null 2>&1); then
  echo "  fixtures reseeded"
else
  echo "  $(red WARNING): reseed failed — picker assertions may be stale"
fi

OFFICER=$(login officer@loan.local)
ADMIN=$(login admin@loan.local)
ACCT=$(login accountant@loan.local)
HO="Authorization: Bearer $OFFICER"
HA="Authorization: Bearer $ADMIN"
HC="Authorization: Bearer $ACCT"

if [ -z "$OFFICER" ]; then
  echo "$(red 'Could not sign in') as officer@loan.local — is the seed applied?" >&2
  exit 1
fi

# ── auth ──────────────────────────────────────────────────────────────

echo "── auth ──────────────────────────────────────────────────────────"
check "officer login returns a token" "$([ -n "$OFFICER" ] && echo yes || echo no)" "yes"
code 401 "no token is rejected" "$API/customers"
code 401 "garbage token is rejected" "$API/customers" -H "Authorization: Bearer not.a.jwt"
FORGED=$(node -e "
const h=Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url');
const p=Buffer.from(JSON.stringify({sub:'x',role:'ADMIN',exp:Math.floor(Date.now()/1000)+9999})).toString('base64url');
console.log(h+'.'+p+'.');
")
code 401 "alg:none forgery is rejected" "$API/customers" -H "Authorization: Bearer $FORGED"

# ── RBAC ──────────────────────────────────────────────────────────────

echo "── RBAC gates (staff must still work) ────────────────────────────"
code 200 "officer: GET /customers" "$API/customers" -H "$HO"
code 200 "officer: GET /loans" "$API/loans" -H "$HO"
code 200 "officer: trial balance" "$API/accounting/reports/trial-balance" -H "$HO"
code 200 "accountant: GET /customers" "$API/customers" -H "$HC"
code 403 "officer: admin/users is denied" "$API/admin/users" -H "$HO"
code 200 "admin: admin/users" "$API/admin/users" -H "$HA"

# ── picker ────────────────────────────────────────────────────────────

echo "── picker flags (hasLoans / hasDefaulted) ────────────────────────"
FLAGS=$(curl -s "$API/customers" -H "$HO" | node -pe "
const p=JSON.parse(require('fs').readFileSync(0,'utf8'));
const r=p.rows??p; // paginated envelope since the list endpoints paged
const g=n=>r.find(c=>c.number===n);
[g('PICKER-001'),g('PICKER-006'),g('PICKER-009'),g('PICKER-011')]
  .map(c=>c? (c.number+':'+(c.hasLoans?'L':'-')+(c.hasDefaulted?'D':'-')) : 'missing').join(' ');
")
check "flags across the tiers" "$FLAGS" \
  "PICKER-001:-- PICKER-006:L- PICKER-009:-D PICKER-011:LD"

# ── DORSI ─────────────────────────────────────────────────────────────
# 402 here means the licence gate, not authorisation — run pnpm dev:license.

echo "── DORSI (officer needs dorsi.read; writes stay admin-only) ──────"
code 200 "officer: screen-by-name" -X POST "$API/dorsi/screen-by-name" \
  -H "Content-Type: application/json" -H "$HO" -d '{"name":"Wilma Writeoff"}'
code 403 "officer: dorsi tag is denied" -X POST "$API/dorsi/" \
  -H "Content-Type: application/json" -H "$HO" -d '{}'
code 403 "officer: board-approval denied" -X POST "$API/dorsi/board-approval" \
  -H "Content-Type: application/json" -H "$HO" -d '{}'

# ── payments ──────────────────────────────────────────────────────────

echo "── payments (provider selection + sandbox flow) ──────────────────"
code 400 "webhook/gcash -> ProviderMismatch" -X POST "$API/payments/webhook/gcash" \
  -H "Content-Type: application/json" -d '{"data":{"id":"x","status":"PAID"}}'

LOAN=$(curl -s "$API/loans" -H "$HO" | node -pe "
const p=JSON.parse(require('fs').readFileSync(0,'utf8'));
const r=p.rows??p; // paginated envelope since the list endpoints paged
const l=r.find(x=>['ACTIVE','DISBURSED'].includes(x.status))||r[0];
l?l.id:'';
")
KEY="e2e-$$"
INTENT=$(curl -s -X POST "$API/payments/intents" -H "Content-Type: application/json" \
  -H "$HC" -d "{\"loanId\":\"$LOAN\",\"amount\":100,\"idempotencyKey\":\"$KEY\"}")
EXT=$(echo "$INTENT" | node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8')).externalId}catch(e){''}")
check "intent created with mock externalId" "$EXT" "mock_$KEY"

SETTLED=$(curl -s -X POST "$API/payments/mock/confirm/$EXT" \
  -H "Content-Type: application/json" -d '{"status":"PAID"}' |
  node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8')).intentStatus}catch(e){'err'}")
check "sandbox confirm settles the intent" "$SETTLED" "PAID"

# ── amortization ──────────────────────────────────────────────────────

echo "── amortization reconciliation (via /loans/quote) ────────────────"
RECON=$(curl -s -X POST "$API/loans/quote" -H "Content-Type: application/json" -H "$HO" \
  -d '{"principal":50000,"termMonths":12,"annualInterestRate":0.24}' | node -pe "
const q=JSON.parse(require('fs').readFileSync(0,'utf8'));
const r2=n=>Math.round(n*100)/100;
const sumPrincipal=r2(q.schedule.reduce((s,x)=>s+x.principal,0));
const rowsConsistent=q.schedule.every(x=>r2(x.principal+x.interest)===x.payment);
const closesAtZero=q.schedule[q.schedule.length-1].balance===0;
(sumPrincipal===50000 && rowsConsistent && closesAtZero) ? 'ok' : 'drift';
")
check "schedule reconciles + rows consistent" "$RECON" "ok"

echo
if [ "$fail" -eq 0 ]; then
  echo "══ $(green "$pass passed"), 0 failed ══"
else
  echo "══ $pass passed, $(red "$fail failed") ══"
fi
[ "$fail" -eq 0 ]
