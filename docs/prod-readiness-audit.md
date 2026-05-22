# Production readiness audit

Snapshot of CI, container, and database posture as of this session.
Items are categorised so triage is obvious before a real deploy.

## ✅ Already solid

### CI (`.github/workflows/ci.yml`)

- Concurrency control cancels in-flight runs per branch/PR — saves Actions minutes.
- Four parallel jobs (validate, typecheck, build, test) with pnpm store cache via `actions/setup-node` — ~90 s warm.
- `prisma validate` + `prisma format --check` catches schema drift.
- `docker-build` smoke job runs on `main` only via `if: github.ref == 'refs/heads/main'` so PRs don't pay the docker build tax.
- Buildx + gha cache on the docker job — incremental builds.
- Tests now cover 4 libs (kyc, accounting, loans, db/dorsi-helpers) → 84 tests; `pnpm test` is `nx run-many -t test` so newly-added test scripts pick up automatically.

### `apps/api/Dockerfile`

- Multi-stage (builder + runtime); runtime image is `node:20-alpine`.
- Workspace-aware: every `libs/*/package.json` copied so `pnpm install --frozen-lockfile` doesn't fail on the missing-manifest validation.
- `tini` as PID 1 for proper signal forwarding.
- Runs as non-root `node` user with `chown` on `/app/uploads` + `/app`.
- `HEALTHCHECK` against `/api/v1/health/ready` — Docker daemon + Compose `service_healthy` both wire up.
- OCI image labels (title, description, source, licenses).
- Entrypoint script gracefully chooses `prisma migrate deploy` vs `prisma db push` based on whether migrations exist.
- Prisma binary invoked by absolute path so `npx` doesn't fetch fresh copies from the registry at boot.

### `apps/web/Dockerfile`

- Multi-stage builder + nginx:alpine runtime.
- SPA-aware nginx config replacing the default site.
- `HEALTHCHECK` against `/`.
- OCI labels.
- **Fixed this session**: the manifest COPY list was missing 7 lib packages (accounting, decisioning, jobs, notifications, payments, pdf, screening). `pnpm install --frozen-lockfile` would have failed on a clean cache — pnpm validates the entire workspace. Now mirrors the api Dockerfile's full set.

### `docker-compose.yml`

- Postgres healthcheck (`pg_isready`) gates `api` startup via `depends_on.condition: service_healthy`.
- `api` healthcheck gates `web` startup the same way.
- Named volumes for pgdata + uploads + pgadmin + ollama survive `docker compose down`.
- Profiles separate concerns: default = db only (for dev), `full` = stack, `ai` = optional Ollama.
- Sensible defaults via `${VAR:-default}` so first-time users don't need a `.env` file to run.

### Database (`libs/db/prisma/schema.prisma`)

- Indexes already cover most hot paths:
  - Customer: `phone`, `(governmentIdType, governmentIdNumber)`
  - KycSubmission: `(customerId, documentType)`, `status`
  - LoanApplication: `(customerId, status)`, `(status, submittedAt)`, `productCode`
  - LoanSchedule: unique `(loanId, installmentNo)`, `dueDate`
  - LoanPayment: `(loanId, paidOn desc)`
  - JournalEntry: `entryDate`, `(source, sourceRefId)`, `(sourceRefType, sourceRefId)`, `periodId`
  - AuditEvent: `createdAt desc`, `(actorId, createdAt desc)`, `(targetType, targetId)`, `action`
  - Notification: `createdAt desc`, `status`, `(customerId, createdAt desc)`, `event`
  - AmlScreening: `(customerId, screenedAt desc)`, `status`
  - PaymentIntent: unique `(provider, externalId)`, `status`, `(loanId, createdAt desc)`
  - LoanApproval: unique `(loanId, stepOrder)`, `(loanId, status)`, `approverId`

## ⚠️ Recommended before production deploy

### CI

- **No lint step.** The repo has Prettier (`pnpm format`) but no ESLint pipeline. Either add an `eslint` config + CI job, or accept that style consistency relies on `lint-staged` at commit time only. Low risk; just visibility.
- **No security scan.** Consider `npm audit --audit-level=high` or Snyk/Dependabot for dependency vulnerability surfacing. Low effort if you accept GitHub's free Dependabot.
- **No E2E test.** Vitest covers pure logic; nothing exercises the actual HTTP API or browser flow. Playwright against the docker-compose stack would close the gap. The smoke-test checklist at `docs/smoke-tests/customer-flows.md` is the manual stand-in until then.
- **Single OS runner.** All jobs run on `ubuntu-latest`. If you anticipate Mac/Windows dev hosts hitting OS-specific issues, add a matrix. Otherwise skip.

### API Dockerfile

- **`COPY libs ./libs` ships everything**, including libs the api doesn't use at runtime (e.g. `ui`, `pdf` for the web). Trims a few MB off the image but isn't security-critical. Defer.
- **No `.dockerignore` reference in this audit** — check that one exists at repo root to keep `node_modules`/`dist`/`.git` out of the build context. If it's already there, this is a no-op.
- **Migrate failure on boot is fatal but the container exits clean** — orchestrators (k8s, ECS) would restart in a loop. Consider adding `set -e` explicitly and a clear error log line if `migrate deploy` fails, so the restart-loop is debuggable from container logs alone.

### Web Dockerfile

- **No nginx security headers** beyond what comes default. Production deploys behind a managed LB (Cloudflare, AWS ALB) usually inject CSP / HSTS / X-Frame-Options at the edge. If you serve nginx publicly, harden `apps/web/nginx.conf` with at least `Strict-Transport-Security` and `X-Content-Type-Options: nosniff`.
- **gzip / brotli not explicitly configured** — check `nginx.conf`. Vite outputs already-minified bundles, but gzip on the wire still helps text/json/css.

### docker-compose

- **`JWT_SECRET` default in compose is a placeholder.** Acceptable for dev; never a production value. Document in deploy runbook that this MUST be rotated before any internet-facing run.
- **Postgres password defaults to `loan`** — same caveat.
- **No log rotation config.** Long-running containers will accumulate stdout. Production deploys typically use `logging.driver: "json-file"` with `max-size` + `max-file` to bound disk usage. Add when deploying outside a managed log aggregator.
- **`smart-loan-pgadmin`** is mounted on host port 5050 with default admin/admin creds (gated behind the `full` profile). Fine for dev — for any shared environment, change creds via `.env`.

### Database / Prisma

- **Customer lacks an index on `email`** despite email being required and queried (e.g., during account provisioning, statement-ready notifications). Add: `@@index([email])`. Worth a follow-up migration; impact is minimal at the current scale but it's the right shape.
- **Customer lacks an index on `(lastName, firstName)`** — used by the DORSI fuzzy-screen + customer search. The current screen reads ALL active records into memory, so it works without the index today; if customers cross ~10k, switch to a generated full-text column + index.
- **PaymentIntent.idempotencyKey is unique-per-provider but not unique alone** — that's the right shape since two providers might legitimately reuse a key. Already covered by `@@unique([provider, externalId])`.
- **No archive strategy.** Notifications, AuditEvent, JobRun all grow forever. Add a monthly cleanup job that moves rows older than N days to a `*_archive` table (or just deletes them, depending on retention policy). The job scheduler exists — wire one in when you have a retention number from compliance.

## 🔵 Nice-to-have

- **Multi-arch images** (`linux/arm64` + `linux/amd64`) so M-series Macs in dev don't have to emulate. Buildx supports this with `--platform`.
- **Image scanning** in CI (Trivy or grype against `smart-loan-api:ci` after the docker-build job).
- **Distroless runtime** instead of `node:20-alpine` — smaller, smaller attack surface. Tradeoff is debugging (no shell). Probably overkill until prod.
- **Prisma migration shadow database** — currently `prisma migrate dev` uses the local pg; in CI it's fine since validate doesn't apply migrations.
- **HTTPS in dev** for getUserMedia testing without going to https://localhost. mkcert + caddy would do it. Track as a dev-experience improvement.
- **OpenAPI spec export** — Swagger UI is wired up at `/docs`, but exporting a static `openapi.json` to the build pipeline would let clients generate their own SDKs.

## 🟢 Safe-as-is

- Per-env config via `${VAR:-default}` substitution.
- Postgres 16 (current LTS-ish) + alpine variant for size.
- Non-root user in api container.
- Volumes named so `docker compose down -v` is an explicit nuke.
- Workspace-aware pnpm install layer caching in both Dockerfiles.

## Action items by triage

| Severity     | Item                                                                         | Effort      |
| ------------ | ---------------------------------------------------------------------------- | ----------- |
| Must fix     | Rotate `JWT_SECRET` + `POSTGRES_PASSWORD` defaults at deploy time            | Procedural  |
| Must fix     | Document log retention + add `logging.driver` to compose for managed deploys | 5 min       |
| Should       | Add `Customer.email` index                                                   | 1 migration |
| Should       | Add ESLint config + CI job                                                   | ~30 min     |
| Should       | nginx security headers in `apps/web/nginx.conf`                              | 10 min      |
| Should       | Dependabot or `npm audit` step in CI                                         | 5 min       |
| Nice-to-have | Playwright E2E suite covering the customer flows checklist                   | Half-day    |
| Nice-to-have | Image scanning + multi-arch                                                  | Bounded     |
| Nice-to-have | Notification/audit archival job                                              | Bounded     |

## What was applied inline this session

- ✓ `apps/web/Dockerfile` — added missing lib package COPY lines (accounting, decisioning, jobs, notifications, payments, pdf, screening). A clean docker build would have failed without these on `pnpm install --frozen-lockfile`.
