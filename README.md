# SmartLoan

An advanced loan-application platform with FICO-style **credit scoring**,
multi-step **survey + behavioral signals**, **KYC document workflow**, and
amortization-aware loan management.

> Sibling of the [Click-POS](../app) monorepo — uses the same pnpm + Nx
> structure, the same `@loan/*` import-path convention (mirroring
> `@pos/*`), and the same React + Fastify + Prisma + Postgres stack.

---

## What it does

1. **Capture** the customer profile (employment, income, ID).
2. **Verify** them via a KYC document pack (ID front/back, proof of income,
   proof of address, selfie). Officers approve/reject each document; the
   rollup status is computed automatically.
3. **Score** them via a hybrid survey: weighted questions sum to a raw
   total, blended with behavioral signals (prior-loan history, default
   count, on-time rate). The result is scaled to the standard **300–850**
   FICO band and tagged with a tier (**A** Prime → **F** Decline).
4. **Quote → Apply → Decide → Disburse → Repay**. Amortization is
   materialized into a `LoanSchedule` so each `LoanPayment` can be matched
   against an installment with proper principal/interest split.

---

## Quickstart

### Option A — dev workflow (recommended)

Database in Docker, api + web on the host so hot-reload works.

```bash
# 1. One-time env setup
cp .env.example .env
cp apps/api/.env.example apps/api/.env

# 2. Start postgres only
pnpm db:up

# 3. Install + migrate + seed (creates admin@loan.local / P@ssw0rd123)
pnpm install
pnpm db:migrate
pnpm db:seed

# 4. Run web + api together
pnpm dev
# → API     http://localhost:3001  (swagger at /docs)
# → Web app http://localhost:5173
```

### Option B — full stack in Docker

Everything containerized: db + api + web (nginx) + pgadmin.

```bash
cp .env.example .env                 # tweak JWT_SECRET before shipping
docker compose --profile full up -d --build

# → Web      http://localhost:5173   (nginx proxies /api → api container)
# → API      http://localhost:3001   (direct, /docs for swagger)
# → pgAdmin  http://localhost:5050   (admin@loan.local / admin)
```

Migrations run automatically on every api container boot
(`prisma migrate deploy`). To re-seed:

```bash
docker compose exec api node -e "import('@loan/db/src/seed.js')"
# or simply: docker compose exec api npx prisma db seed --schema libs/db/prisma/schema.prisma
```

Stop everything:

```bash
docker compose --profile full down          # keeps data
docker compose --profile full down -v       # nukes db + uploads volumes
```

Default credentials:

| Email | Password | Role |
| --- | --- | --- |
| admin@loan.local | P@ssw0rd123 | ADMIN |
| officer@loan.local | P@ssw0rd123 | LOAN_OFFICER |

---

## Repo layout

```
apps/
  api/                Fastify 5 server (auth, customers, KYC, scoring, loans)
  web/                React + Vite PWA (officer dashboard)

libs/
  db/                 Prisma schema + repositories + seed
  credit-scoring/     Factor catalog + survey definitions + compute()
  loans/              Amortization math
  kyc/                Document-pack validation
  auth/               Argon2id + JWT Fastify plugin
  api-client/         Typed fetch wrapper + TanStack Query hooks
  shared-types/       Transport types shared by api + web
  shared-utils/       formatMoney / formatDate / clamp / …
  features/           Feature-flag registry
  ui/                 shadcn-flavored React component library
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the request-flow walkthrough
and **[PACKAGES.md](./PACKAGES.md)** for the per-package contract.

---

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run `api` and `web` in parallel via Nx. |
| `pnpm dev:api` / `pnpm dev:web` | Just one side. |
| `pnpm db:migrate` | Apply Prisma migrations to your local Postgres. |
| `pnpm db:seed` | Re-seed the two demo users + a starter customer. |
| `pnpm db:studio` | Open Prisma Studio. |
| `pnpm typecheck` | TS across every package. |
| `pnpm build` | Production build of api + web. |

---

## Domain model (one paragraph)

A **Customer** holds the underwriting profile. They submit one or more
**KycSubmissions** (documents) which are reviewed and rolled up into the
customer's `kycStatus`. They take a **SurveyResponse**; the scoring
engine combines those answers with behavioral signals to produce a
**CreditScore** snapshot. With KYC verified and a score on file, they
can file a **LoanApplication** — the score is captured at the time of
apply so later re-scoring doesn't alter underwriting history. Once
approved and disbursed, a **LoanSchedule** is materialized so each
inbound **LoanPayment** can be applied installment-by-installment.
