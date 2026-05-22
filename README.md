# SmartLoan

An installable, AI-augmented loan management platform for Philippine
cooperatives and small lenders. Officer console for origination,
KYC, decisioning, servicing, collections, accounting, and reporting —
plus a borrower portal. Everything runs on infrastructure you control.

> Sibling of the [Click-POS](../app) monorepo — same pnpm + Nx structure,
> same `@loan/*` import convention, same React + Fastify + Prisma +
> Postgres stack.

---

## At a glance

**Core lending lifecycle**

- Customer onboarding with KYC document pack
- Hybrid credit scoring (survey + behavioral signals), 300-850 FICO band, A-F tier
- 5-step **loan application wizard** with auto-saved drafts
- Configurable loan products (Salary, Auto, Motorcycle, Housing, Lease-to-Own)
- Decisioning rules engine + dry-run preview before submit
- Disbursement → repayment schedule → installment-by-installment payment matching
- Restructuring, write-offs, penalty waivers, repeat-loan fast path
- Collections queue with notes, PTPs, late-fee accrual, demand letters (FRD §3.6 escalation matrix), repossession (BM → Credit → Legal → Agent)

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
capital.

**Smart features inside the apply wizard**

- Borrower context bar (income, KYC, score, prior defaults, DORSI flag)
- Per-product KYC gap warning (blocks submit until verified)
- Live affordability calculator (EMI + DTI + max-safe principal)
- DORSI cap projection for tagged customers
- Pre-decisioning preview (stoplight verdict + matched rule + anomaly flags)

**Differentiators that run locally**

- **In-browser ID OCR** — drop a gov't ID photo or use the camera, Tesseract.js extracts name / DOB / ID number
- **Face match** — face-api.js compares the application selfie to the verified ID photo, scores similarity in the browser
- **Anomaly flagger** — pure-stats z-score outlier detection against the product's historical baseline
- **Local LLM assistant** — Ollama-based "explain decision / draft demand letter / summarize account" tasks. Never sends data to OpenAI / Anthropic
- **PWA** — installable as a desktop / mobile app; auto-update banner on new releases

**Operational extras** — RBAC + delegations, 2FA TOTP, refresh tokens,
in-app messaging, scheduled job runner, audit log of every privileged
action, Sentry integration.

---

## Quickstart

Everything runs on the host directly — `tsx` for the API, Vite for the
web app, Postgres as a local service. No Docker.

### Prerequisites

- **Node ≥ 20.11** and **pnpm ≥ 9** (see `engines` in `package.json`)
- **Postgres ≥ 14** running locally on `localhost:5432`
  - macOS: [Postgres.app](https://postgresapp.com) or `brew install postgresql@16`
  - Windows: [installer from postgresql.org](https://www.postgresql.org/download/windows/)
  - Linux: `sudo apt install postgresql` (or your distro's equivalent)

### One-time setup

```bash
# 1. Create the database (any client; this is the psql one-liner)
createdb -U postgres smart_loan
# or, from inside psql:
#   CREATE DATABASE smart_loan;

# 2. Copy the env template + tweak DATABASE_URL if your Postgres user
#    / password / port differ from the defaults
cp .env.example .env

# 3. Install workspace deps + generate the Prisma client + run migrations
pnpm install
pnpm db:migrate
pnpm db:seed
```

The seed creates two demo users:

| Email              | Password    | Role         |
| ------------------ | ----------- | ------------ |
| admin@loan.local   | P@ssw0rd123 | ADMIN        |
| officer@loan.local | P@ssw0rd123 | LOAN_OFFICER |

### Running

```bash
pnpm dev          # api + web in parallel, hot reload on both
# or one side only:
pnpm dev:api
pnpm dev:web
```

Open:

- **Web**: <http://localhost:5173>
- **API**: <http://localhost:3001/docs> (Swagger)

### Optional — AI assistant via Ollama

The AI side-panel works without this; it just returns canned mock
responses. To enable real LLM-backed answers:

```bash
# 1. Install Ollama for your platform: https://ollama.com
# 2. Pull a model
ollama pull phi3:mini
# 3. Point the API at it
echo 'OLLAMA_URL=http://localhost:11434' >> .env
# 4. Restart the api (pnpm dev:api)
```

The assistant card on the loan detail page flips from "Mock · not
ready" to "phi3:mini · ready" once the URL resolves.

---

## Required configuration

Everything is documented in `.env.example`. The essentials:

| Variable         | Required?           | What it does                                                                       |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Yes                 | Postgres connection. Defaults to `postgres://loan:loan@localhost:5432/smart_loan`. |
| `JWT_SECRET`     | Yes                 | Signs JWTs. Must be 32+ chars; production refuses to boot with the default.        |
| `WEB_ORIGIN`     | Yes                 | CORS allowlist. Set to your public web URL in prod.                                |
| `PUBLIC_API_URL` | Prod only           | Public URL the API advertises in payment webhooks + PDF document refs.             |
| `COMPANY_NAME`   | No                  | Display name in generated PDFs. Defaults to "SmartLoan".                           |
| `TOTP_ISSUER`    | No                  | Issuer label in 2FA apps.                                                          |
| `SENTRY_DSN`     | Recommended in prod | Empty disables error reporting.                                                    |
| `UPLOADS_DIR`    | No                  | Where uploaded docs land. Defaults to `./uploads` relative to cwd.                 |
| `SYSTEM_USER_ID` | Recommended         | UUID of a real "system" user for scheduled-job audit attribution.                  |

### Optional provider switches (default all `MOCK`)

| Variable                | Allowed values                                            | Required creds                       |
| ----------------------- | --------------------------------------------------------- | ------------------------------------ |
| `NOTIFICATION_PROVIDER` | `MOCK` / `SENDGRID` / `TWILIO` / `SES`                    | `SENDGRID_API_KEY`, `TWILIO_*`, etc. |
| `PAYMENT_PROVIDER`      | `MOCK` / `GCASH` / `MAYA` / `DRAGONPAY`                   | `GCASH_*`, `MAYA_*`, `DRAGONPAY_*`   |
| `AML_PROVIDER`          | `MOCK` / `COMPLY_ADVANTAGE` / `REFINITIV` / `WORLD_CHECK` | `COMPLY_ADVANTAGE_API_KEY`, etc.     |

Set a real provider but forget its creds → boot fails loudly. Stay on
`MOCK` for dev / CI; the mocks are deterministic and don't hit the
network.

### Optional AI assistant

| Variable            | Default      | Notes                                                                      |
| ------------------- | ------------ | -------------------------------------------------------------------------- |
| `OLLAMA_URL`        | empty (mock) | Set to `http://localhost:11434` after installing Ollama on the host.       |
| `OLLAMA_MODEL`      | `phi3:mini`  | The first model you pull. `llama3.1:8b` is smarter but ~4.7 GB and slower. |
| `OLLAMA_MAX_TOKENS` | `512`        | Soft cap on response length.                                               |

### Optional face-match models

`@vladmandic/face-api` model weights need to live at `/models/` in the
web app for the face-match panel to work. Either:

- **Self-host** — copy files from
  <https://github.com/vladmandic/face-api/tree/master/model> into
  `apps/web/public/models/`. ~6 MB total.
- **CDN** — set `VITE_FACE_API_MODELS=https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/`
  at build time. Convenient for dev; production should self-host so
  models survive a vendor outage.

The card auto-hides when there's nothing to compare (no selfie or no
verified ID).

---

## Repo layout

```
apps/
  api/          Fastify 5 server: auth, customers, KYC, scoring, loans,
                accounting, collections, payments, reports, assistant
  web/          React + Vite PWA (officer dashboard + borrower portal)

libs/
  db/                Prisma schema + repositories + migrations + seed
  credit-scoring/    Factor catalog, survey, scoring compute()
  loans/             Amortization, fees, EMI helpers
  decisioning/       Rules engine + DSL
  kyc/               Document validation
  auth/              Argon2id + JWT plugin
  pdf/               PDF document renderers (agreement, demand letter, etc.)
  jobs/              Scheduled-job framework
  features/          Feature-flag registry
  api-client/        Typed fetch + TanStack Query hooks
  shared-types/      Transport types
  shared-utils/      formatMoney / formatDate / clamp / …
  ui/                shadcn-flavored component library + tour + selfie + dropzone + stepper
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the request flow and
**[PACKAGES.md](./PACKAGES.md)** for the per-package contract.

---

## Common scripts

| Command                         | What it does                                                  |
| ------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                      | Run `api` and `web` in parallel via Nx (hot-reload dev mode). |
| `pnpm dev:api` / `pnpm dev:web` | Just one side.                                                |
| `pnpm db:migrate`               | Apply Prisma migrations to your local Postgres.               |
| `pnpm db:generate`              | Regenerate the Prisma client after a schema edit.             |
| `pnpm db:seed`                  | Re-seed the demo users + starter customer + default products. |
| `pnpm db:studio`                | Open Prisma Studio for browsing the DB.                       |
| `pnpm typecheck`                | TypeScript across every package.                              |
| `pnpm build`                    | Production build of api + web.                                |
| `pnpm test`                     | Run unit tests (vitest).                                      |

After schema changes, regenerate the Prisma client:

```bash
pnpm --filter @loan/db exec prisma generate
```

---

## Optional: enable the PWA install affordance

The web app is **already a PWA** — when served over HTTPS (or
`http://localhost`), browsers will show an install prompt. Nothing to
configure. To customize:

- Icons: `apps/web/public/icons/icon.svg` + `icon-maskable.svg`
- Manifest: declared in `apps/web/vite.config.ts` (name, theme color, display mode, runtime cache rules)
- Offline fallback: `apps/web/public/offline.html`

The service worker auto-updates: when you deploy a new build, users see
a "New version available · Reload now" banner. They pick when to apply.

---

## Troubleshooting

**Prisma can't find `DATABASE_URL` when running `migrate deploy`** — copy
the root `.env` next to the schema: `cp .env libs/db/.env`. Prisma looks
for env next to its schema, not at the repo root.

**`Command "prisma" not found`** — this is a cascading error after a
schema validation failure. Real cause is usually `DATABASE_URL` (see above).

**`tsc` errors about `penaltyWaiver` / `RepossessionCase` not on
PrismaClient** — the Prisma client is stale after a schema edit. Run:

```bash
pnpm --filter @loan/db exec prisma generate
```

**Camera permission denied (selfie / ID capture)** — browsers block
`getUserMedia` outside HTTPS / localhost. For dev, stick to
`http://localhost:5173`. For production, you must serve over HTTPS.

**Face-match: "Model weights couldn't be reached"** — you haven't put
model files into `apps/web/public/models/`. See the face-match section
above.

**AI assistant returns "configure Ollama" mock** — `OLLAMA_URL` is
empty. Either set it to a reachable Ollama server, or accept the mock
provider (everything else still works).

**`ECONNREFUSED` against Postgres on `pnpm db:migrate`** — Postgres
isn't running, or it's listening on a port `DATABASE_URL` doesn't
expect. Check the service is up (`pg_isready` / `brew services list` /
your OS service manager) and that the port matches.

**`database "smart_loan" does not exist`** — create it once:
`createdb -U postgres smart_loan` (or `CREATE DATABASE smart_loan` in
psql).

---

## Domain model (one paragraph)

A **Customer** holds the underwriting profile. They submit one or more
**KycSubmissions** (documents) which are reviewed and rolled up into the
customer's `kycStatus`. They take a **SurveyResponse**; the scoring
engine combines those answers with behavioral signals to produce a
**CreditScore** snapshot. With KYC verified and a score on file, they
can file a **LoanApplication** — the score is captured at the time of
apply so later re-scoring doesn't alter underwriting history. The
**DecisionRule** engine evaluates the application against admin-tunable
rules (`AUTO_APPROVE` / `AUTO_REJECT` / `MANUAL_REVIEW`). Once approved
and disbursed, a **LoanSchedule** is materialized so each inbound
**LoanPayment** can be applied installment-by-installment. The full
double-entry GL (**Account** + **JournalEntry** + **JournalLine**)
auto-posts on every cash event so finance can close the books cleanly.

---

## License

MIT — see [LICENSE](./LICENSE) if present, otherwise the project is
released under MIT terms.
