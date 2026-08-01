# Smart Loan v1.0.0

A loan management platform for Philippine cooperatives and small lenders.
Ships as **either** an on-prem single-tenant install (one cooperative
hosts their own) **or** a multi-tenant SaaS (one vendor hosts many).
Officer console for origination, KYC, decisioning, servicing, collections,
accounting, and reporting; borrower portal for self-service apply, KYC
capture, online payments, and document downloads.

Everything runs on infrastructure you control. No data leaves the host
unless you wire a real provider (Twilio / SendGrid / GCash / etc.) —
defaults are deterministic mocks.

---

## At a glance

**Core lending lifecycle**

- Customer onboarding with KYC document pack + camera/upload capture
- Hybrid credit scoring (survey + behavioral), 300–850 FICO band, A–F tier
- 5-step **loan application wizard** with auto-saved drafts
- Configurable loan products (Salary, Auto, Motorcycle, Housing, Lease-to-Own)
- Decisioning rules engine + dry-run preview before submit
- Disbursement → repayment schedule → installment-by-installment payment matching
- Restructuring, write-offs, penalty waivers, repeat-loan fast path
- Collections queue with notes, PTPs, late-fee accrual, demand letters
  (FRD §3.6 escalation matrix), repossession (BM → Credit → Legal → Agent)
- Lease-to-Own with end-of-term notices, maintenance reminders, pull-out workflow

**Accounting + compliance**

- Full double-entry GL (auto-posted on every cash event)
- Period close / reopen, monthly interest accrual
- Bank reconciliation with auto-match + manual attach
- IFRS-9 ECL provisioning with stage breakdown
- DORSI compliance (FRD §3.10) — cap math + board-approval gating
- Annual / renewable docs tracking with expiry reminders
- 6 exportable compliance reports

**Cooperative modules** — contributions (CBU / Mortuary / Emergency),
savings, fund movements, expenses, other income, Big-Brother external
capital, member ledger spanning loans + coop activity.

**Multi-tenancy (v1.0.0)**

- Schema-per-tenant via `?schema=tenant_<slug>` in the Postgres DSN
- One vendor process serves N cooperatives; each cooperative's data lives
  in its own Postgres schema; cross-tenant reads are impossible by
  construction
- Platform console for vendor staff: tenant provisioning, license
  issuance, support impersonation, cross-tenant audit
- Per-tenant Twilio + SendGrid credentials (fallback to platform-shared)
- Schema-rename adoption CLI for moving an existing single-tenant
  install into multi-tenant mode

**PH Data Privacy Act compliance**

- §16(c) data export — DSAR JSON download spanning every table
- §16(e) right to erasure — soft-erasure of PII; AMLA-required
  financial records retained per regulatory floor
- Per-tenant retention policy with nightly purge (audit 5y / notif 1y /
  jobs 90d defaults)
- Impersonation audit propagation — vendor support sessions
  attribute every action to both the tenant user AND the operator

**Differentiators that run locally**

- **In-browser ID OCR** (Tesseract.js)
- **Face match** between selfie ↔ ID (face-api.js)
- **Anomaly flagger** — z-score outlier detection
- **Local LLM assistant** (Ollama) — explain decision / draft demand
  letter / summarize account. Never leaves the host.
- **PWA** — installable as desktop / mobile app; auto-update banner

**Operational extras** — RBAC + delegations, 2FA TOTP, refresh tokens,
in-app messaging, per-tenant scheduled job runner, audit log of every
privileged action, Sentry integration with per-tenant tagging.

---

## Setup

### Prerequisites

- **Node ≥ 20.11** and **pnpm ≥ 9** (see `engines` in `package.json`)
- **Postgres ≥ 14** running locally on `localhost:5432`
  - macOS: [Postgres.app](https://postgresapp.com) or `brew install postgresql@16`
  - Windows: [installer from postgresql.org](https://www.postgresql.org/download/windows/)
  - Linux: `sudo apt install postgresql` (or distro equivalent)

### One-time setup

```bash
# 1. Clone + install deps
git clone <repo>
cd smart-loan-app
pnpm install

# 2. Copy the env template
cp .env.example .env

# 3. Start Postgres in Docker, generate the client, migrate, seed
pnpm dev:up
```

`pnpm dev:up` brings up the throwaway dev database defined in
[`docker-compose.dev.yml`](./docker-compose.dev.yml) — Postgres 16 on
`127.0.0.1:5433`, which is what `.env.example`'s `DATABASE_URL` already
points at — then runs `db:generate`, `prisma migrate deploy` and
`db:seed` against it. `pnpm dev:db:down` stops it; `pnpm dev:db:reset`
also deletes its volume.

<details>
<summary>Using your own Postgres instead of Docker</summary>

```bash
createdb -U postgres smart_loan     # or, in psql: CREATE DATABASE smart_loan;
# point DATABASE_URL in .env at it (default template assumes :5433)
pnpm db:migrate
pnpm db:seed
```

</details>

To run the whole application in Docker — API, web and Postgres, the
same stack a cooperative installs — see
[Docker (full stack)](#docker-full-stack) below.

The seed creates a starter customer + default loan products + RBAC
catalog + two demo users:

| Email                | Password    | Role         |
| -------------------- | ----------- | ------------ |
| `admin@loan.local`   | P@ssw0rd123 | ADMIN        |
| `officer@loan.local` | P@ssw0rd123 | LOAN_OFFICER |

For the **platform console** (vendor side, only relevant in multi-tenant
mode), a default `PLATFORM_ADMIN` is seeded on first boot using:

- email: `PLATFORM_BOOTSTRAP_EMAIL` (default `platform@smartloan.local`)
- password: `PLATFORM_BOOTSTRAP_PASSWORD` (default `ChangeMeNow!2026`)

Change both in production.

---

## Running

The workspace has **four** runnable apps. The most common dev session
is `api + web` together (the cooperative-staff console + the borrower
portal). Marketing + platform are separate.

```bash
# Both common surfaces — api + web (hot-reload, parallel)
pnpm dev

# One at a time:
pnpm dev:api       # Fastify API on :3001
pnpm dev:web       # React/Vite officer + borrower SPA on :5173

# Vendor-side (multi-tenant SaaS only):
pnpm --filter @loan/platform dev   # Platform console on :5174
pnpm --filter @loan/marketing dev  # Public marketing site on :5175
```

Open:

| Surface          | URL                          | Who it's for                |
| ---------------- | ---------------------------- | --------------------------- |
| Officer + portal | <http://localhost:5173>      | Staff + borrowers           |
| API + Swagger    | <http://localhost:3001/docs> | API consumers + curl        |
| Platform console | <http://localhost:5174>      | Vendor support staff (SaaS) |
| Marketing site   | <http://localhost:5175>      | Public landing + lead form  |

Sign in at `/login` with the seeded admin to see everything.

### Database utilities

```bash
pnpm db:studio                                    # Prisma Studio (browse rows)
pnpm db:generate                                  # After a schema.prisma edit
pnpm --filter @loan/db migrate-tenants            # Apply migrations to each tenant schema
pnpm --filter @loan/db adopt-existing-as-tenant   # One-time: move single-tenant data into a tenant schema
```

### Docker (full stack)

`pnpm dev` runs the API and web on the host and only uses Docker for
Postgres. To instead run **the whole application in containers** — the
same api + web + Postgres stack a cooperative installs on-prem — use
[`deploy/docker/`](./deploy/docker/):

```bash
cp deploy/docker/.env.production.example deploy/docker/.env
# fill in POSTGRES_PASSWORD, JWT_SECRET, WEB_ORIGIN

pnpm docker:up:seed      # build → start → wait for healthy → seed
```

Then open `http://localhost:8080` (the `WEB_PORT` in that `.env`) and
sign in with the credentials the seed printed.

`docker:up:seed` is `docker:up` followed by `docker:seed`; both are
listed under [Common scripts](#common-scripts). Seeding is a separate,
profile-gated one-shot service rather than part of `up`, so restarting
the stack never rewrites data. It's also idempotent, so re-running it
after an upgrade just adds whatever defaults the new release
introduced.

Note this stack is production packaging — no hot reload, images rebuilt
on each `docker:up`. For day-to-day development `pnpm dev` is the
faster loop. Full operator docs, backups and TLS:
[`deploy/docker/README.md`](./deploy/docker/README.md).

---

## Single-tenant vs multi-tenant

Smart Loan defaults to **single-tenant** — one Postgres database, one
cooperative, all data in the `public` schema. This is the right mode
for an on-prem deploy.

To run **multi-tenant SaaS**, flip one env var:

```bash
echo 'MULTI_TENANT=true' >> .env
```

In this mode:

- Each cooperative gets its own Postgres schema (`tenant_<slug>`)
- Every authenticated request reads + writes through a per-tenant Prisma
  client whose pool is bound to that schema (no cross-tenant queries
  possible)
- Background jobs fan out across active tenants (one process-level
  interval, per-tenant per-tick)
- The platform console at `/platform/*` handles provisioning, license
  issuance, support sessions
- Tenant admins log in via `/login?tenant=<slug>` instead of just `/login`

Existing single-tenant deploys can migrate to multi-tenant via the
schema-rename adoption CLI — see [`docs/multi-tenant-cutover.md`](./docs/multi-tenant-cutover.md) §2.B.

---

## Required configuration

The full set is documented in `.env.example`; the essentials:

| Variable         | Required? | What it does                                                                   |
| ---------------- | --------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`   | Yes       | Postgres connection. Default `postgres://loan:loan@localhost:5432/smart_loan`. |
| `JWT_SECRET`     | Yes       | Signs JWTs. Must be 32+ chars; production refuses to boot with the default.    |
| `WEB_ORIGIN`     | Yes       | CORS allowlist. Set to your public web URL in prod.                            |
| `MULTI_TENANT`   | No        | `true` enables multi-tenant mode (see above). Default `false`.                 |
| `PUBLIC_API_URL` | Prod only | Public URL the API advertises in payment webhooks + PDF refs.                  |
| `SENTRY_DSN`     | Prod-rec. | Per-tenant tagged error reporting. Empty disables.                             |
| `UPLOADS_DIR`    | No        | Where uploaded docs land. Defaults to `./uploads` relative to cwd.             |
| `SYSTEM_USER_ID` | Prod-rec. | UUID of a real "system" user for scheduled-job audit attribution.              |

### Provider switches (default all `MOCK`)

| Variable                | Allowed values                                            | Required creds                       |
| ----------------------- | --------------------------------------------------------- | ------------------------------------ |
| `NOTIFICATION_PROVIDER` | `MOCK` / `SENDGRID` / `TWILIO` / `SES`                    | `SENDGRID_API_KEY`, `TWILIO_*`, etc. |
| `PAYMENT_PROVIDER`      | `MOCK` / `GCASH` / `MAYA` / `DRAGONPAY`                   | `GCASH_*`, `MAYA_*`, `DRAGONPAY_*`   |
| `AML_PROVIDER`          | `MOCK` / `COMPLY_ADVANTAGE` / `REFINITIV` / `WORLD_CHECK` | `COMPLY_ADVANTAGE_API_KEY`, etc.     |

In multi-tenant mode, each tenant can override notification providers
with their own Twilio + SendGrid keys via the admin UI (Settings →
Notification Providers); the env-var setting is the platform-wide
fallback.

### License (multi-tenant only)

Per-tenant license tokens are signed Ed25519 JWTs. Set on the API host:

| Variable                  | Notes                                                      |
| ------------------------- | ---------------------------------------------------------- |
| `LICENSE_PUBLIC_KEY_PEM`  | Verifies activations. Same key across all tenants.         |
| `LICENSE_PRIVATE_KEY_PEM` | Signs tokens (platform console only — not on tenant hosts) |

The platform console issues licenses; tenant admins paste them at
`/settings/license` to activate.

### Optional AI assistant

| Variable            | Default      | Notes                                                                      |
| ------------------- | ------------ | -------------------------------------------------------------------------- |
| `OLLAMA_URL`        | empty (mock) | Set to `http://localhost:11434` after installing Ollama on the host.       |
| `OLLAMA_MODEL`      | `phi3:mini`  | The first model you pull. `llama3.1:8b` is smarter but ~4.7 GB and slower. |
| `OLLAMA_MAX_TOKENS` | `512`        | Soft cap on response length.                                               |

```bash
# Enable real LLM-backed answers:
# 1. Install Ollama: https://ollama.com
ollama pull phi3:mini
# 2. Point the API at it
echo 'OLLAMA_URL=http://localhost:11434' >> .env
# 3. Restart pnpm dev:api
```

### Optional face-match models

`@vladmandic/face-api` model weights need to live at `/models/` in the
web app for the face-match panel to work:

- **Self-host** — copy files from
  <https://github.com/vladmandic/face-api/tree/master/model> into
  `apps/web/public/models/`. ~6 MB.
- **CDN** — set `VITE_FACE_API_MODELS=https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/`
  at build time.

The card auto-hides when there's nothing to compare.

---

## Repo layout

```
apps/
  api/          Fastify 5 server. ~30 feature folders, layered
                routes → controller → service → repo
  web/          React + Vite PWA (officer console + borrower portal)
  platform/    Vendor control plane (multi-tenant SaaS only)
  marketing/   Public landing + pricing + lead-capture form

libs/
  db/                Prisma schema + repositories + migrations + seed
                     + TenantPrismaCache + TenantScheduler
  credit-scoring/    Factor catalog, survey, scoring compute()
  loans/             Amortization, fees, EMI helpers
  decisioning/       Rules engine + DSL
  kyc/               Document validation
  auth/              Argon2id + JWT plugin + impersonation claim
  licensing/         Ed25519 license signing + verification
  pdf/               PDF document renderers (agreement, demand letter, etc.)
  jobs/              Scheduled-job framework
  payments/          Payment-provider factories (GCash, Maya, Dragonpay)
  notifications/     Notification-provider factories (Twilio, SendGrid, SES)
  screening/         AML provider factories (Comply Advantage, Refinitiv)
  features/          Feature-flag registry
  api-client/        Typed fetch + TanStack Query hooks
  shared-types/      Transport types
  shared-utils/      formatMoney / formatDate / clamp / …
  ui/                shadcn-flavored component library

deploy/
  docker/            Production Docker Compose stack
  bare-metal/        Linux installer (Ubuntu/Debian)
  backup/            Backup + restore scripts

docs/
  RELEASE-1.0.0.md             Release notes for the v1.0.0 tag
  production-deploy.md         Bare-metal walkthrough (3h to first customer)
  multi-tenant-cutover.md      Flipping MULTI_TENANT=true safely
  multi-tenant-implementation.md  Architecture reference
  runbooks.md                  7 operator SOPs for likely incidents
  architecture.md              Layered-feature contract
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the request flow and
**[PACKAGES.md](./PACKAGES.md)** for the per-package contract.

---

## Common scripts

| Command                                           | What it does                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm dev`                                        | Run `api` + `web` in parallel (hot reload).                           |
| `pnpm dev:api` / `pnpm dev:web`                   | Just one side.                                                        |
| `pnpm dev:up`                                     | Start the dev Postgres container, then generate + migrate + seed.     |
| `pnpm dev:db:up` / `pnpm dev:db:down`             | Just start / stop that container.                                     |
| `pnpm dev:db:reset`                               | Stop it **and delete its volume** — wipes local data.                 |
| `pnpm docker:up:seed`                             | Full stack in Docker: build, start, wait for healthy, seed.           |
| `pnpm docker:up` / `pnpm docker:seed`             | The two halves of the above, separately.                              |
| `pnpm docker:logs` / `pnpm docker:ps`             | Tail logs / show status for the full stack.                           |
| `pnpm docker:down`                                | Stop the full stack. Volumes survive.                                 |
| `pnpm docker:reset`                               | Stop it **and delete the DB + uploads volumes**.                      |
| `pnpm db:migrate`                                 | Apply Prisma migrations to your local Postgres.                       |
| `pnpm db:generate`                                | Regenerate the Prisma client after a schema edit.                     |
| `pnpm db:seed`                                    | Re-seed demo users + starter customer + default products.             |
| `pnpm db:studio`                                  | Open Prisma Studio for browsing the DB.                               |
| `pnpm typecheck`                                  | TypeScript across every package.                                      |
| `pnpm build`                                      | Production build of all apps.                                         |
| `pnpm test`                                       | Run unit tests (vitest).                                              |
| `pnpm --filter @loan/db migrate-tenants`          | (Multi-tenant) apply migrations to every tenant schema.               |
| `pnpm --filter @loan/db adopt-existing-as-tenant` | (Multi-tenant) one-shot move single-tenant data into a tenant schema. |

---

## Going to production

When you're ready to deploy a real cooperative:

1. **[`docs/production-deploy.md`](./docs/production-deploy.md)** — 3-hour
   wall-clock walkthrough from a bare Linux VM to first paying customer
   live. Covers bare-metal install, smoke test, backup config, restore
   drill, observability checklist, and the 8-item go-live gate.
2. **[`docs/multi-tenant-cutover.md`](./docs/multi-tenant-cutover.md)** —
   only if running multi-tenant SaaS. Pre-flight checks, the §3 manual
   cross-tenant isolation smoke, env-var flip, post-cutover monitoring.
3. **[`docs/runbooks.md`](./docs/runbooks.md)** — 7 operator SOPs
   for the most likely incidents (tenant stuck provisioning, scheduler
   skipping a tenant, license expired, missing tenant claim, pool
   exhaustion, vendor support session, DSAR procedure).

The web app is a PWA — when served over HTTPS it's installable on
desktop and mobile and auto-updates new builds.

---

## Troubleshooting

**Prisma can't find `DATABASE_URL` when running `migrate deploy`** — copy
the root `.env` next to the schema: `cp .env libs/db/.env`. Prisma
looks for env next to its schema, not at the repo root.

**`Command "prisma" not found`** — cascading error after a schema
validation failure. Real cause is usually a bad `DATABASE_URL`.

**`tsc` errors about new schema fields not on `PrismaClient`** — the
Prisma client is stale after a schema edit. Run:

```bash
pnpm --filter @loan/db exec prisma generate
```

**Camera permission denied (selfie / ID capture)** — browsers block
`getUserMedia` outside HTTPS / localhost. For dev, stick to
`http://localhost:5173`. For production, serve over HTTPS.

**Face-match: "Model weights couldn't be reached"** — you haven't put
model files into `apps/web/public/models/`. See the face-match section
above.

**AI assistant returns "configure Ollama" mock** — `OLLAMA_URL` is
empty. Either set it to a reachable Ollama server, or accept the mock
(everything else still works).

**`ECONNREFUSED` against Postgres on `pnpm db:migrate`** — Postgres
isn't running, or it's listening on a port `DATABASE_URL` doesn't
expect. Check the service is up and the port matches.

**`database "smart_loan" does not exist`** — create it once:
`createdb -U postgres smart_loan` (or `CREATE DATABASE smart_loan` in
psql).

**`MissingTenantClaim` 401 after flipping `MULTI_TENANT=true`** — old
JWT tokens (minted pre-cutover) don't carry the tenant claim. Force a
re-login. See `docs/runbooks.md` R4.

**Tenant stuck in `PROVISIONING` after creating it from the platform
console** — usually a Postgres privilege issue. See `docs/runbooks.md` R1.

---

## Domain model (one paragraph)

A **Customer** holds the underwriting profile. They submit one or more
**KycSubmissions** (documents) which are reviewed and rolled up into the
customer's `kycStatus`. They take a **SurveyResponse**; the scoring
engine combines those answers with behavioral signals to produce a
**CreditScore** snapshot. With KYC verified and a score on file, they
can file a **LoanApplication** — the score is captured at apply time so
later re-scoring doesn't alter underwriting history. The **DecisionRule**
engine evaluates the application against admin-tunable rules
(`AUTO_APPROVE` / `AUTO_REJECT` / `MANUAL_REVIEW`). Once approved and
disbursed, a **LoanSchedule** is materialized so each inbound
**LoanPayment** can be applied installment-by-installment. The full
double-entry GL (**Account** + **JournalEntry** + **JournalLine**)
auto-posts on every cash event so finance can close the books cleanly.

In **multi-tenant mode**, every model except the platform tables
(`Tenant`, `PlatformUser`, `PlatformIssuedLicense`, `PlatformAuditLog`,
`Lead`) lives in a per-tenant Postgres schema; the resolved Prisma
client per request is bound to that schema via `?schema=` in the DSN.

---

## License

MIT — see [LICENSE](./LICENSE) if present, otherwise the project is
released under MIT terms.
