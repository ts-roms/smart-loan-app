# Smart Loan v1.0.0 — release notes

First production-tagged release. The codebase has been "ship-ready"
for a few commits; this tag is the line in the sand. Subsequent
changes follow semver from here.

## §1 — What's in the box

A full loan-servicing system for Philippine cooperatives + the
scaffolding to operate it as either single-tenant on-prem (one
cooperative) or multi-tenant SaaS (a vendor running many).

### Core domain

- **Loans.** Origination → decisioning → disbursement → repayment.
  Per-product configuration (interest method, payment frequency,
  fees, late-fee policy, KYC requirements, approval chain).
  Restructuring + write-off + co-makers.
- **Accounting.** Double-entry GL with chart of accounts, journal
  entries, period close, monthly interest accrual, ECL provisioning
  (IFRS 9).
- **Cooperative-side.** Capital build-up, mortuary, emergency,
  savings, big-brother accounts. Member ledger view spanning
  loans + coop activity.
- **Collections.** Notes + PTPs + late-fee accrual + demand letters
  (4 stages with approval gates) + repossession workflow + lease-to-own
  pull-out flow.
- **Compliance.** AML/PEP/sanctions screening, DORSI register +
  utilization caps, annual document tracker (insurance / RPT
  renewals), FRD-compliant audit trail.
- **Borrower portal.** Self-service application, payment online,
  KYC submit (camera/upload), document download (agreement,
  statement, receipt with e-signature).
- **Decisioning.** Rules engine with credit scoring (300–850),
  per-product KYC gates, affordability + DORSI guardrails,
  pre-decisioning preview.

### Multi-tenancy (Phase 2 — closed)

- Schema-per-tenant via `TenantPrismaCache` — each tenant gets a
  `PrismaClient` bound to `tenant_<slug>` via `?schema=` in the DSN.
- `resolveTenant` preHandler validates the JWT `tenant` claim against
  the platform's `Tenant` catalog before any query runs.
- `TenantScheduler` fans background jobs out across active tenants.
- Per-tenant Twilio + SendGrid credentials (fallback to platform shared).
- Platform console (vendor control plane) for tenant provisioning,
  license issuance, audit, and support impersonation.
- Marketing site + lead capture, on-prem Docker + bare-metal
  packaging, schema-rename adoption for existing single-tenant deploys.

### Compliance (PH PDPA + AMLA)

- §16(c) **data export** — DSAR JSON download spanning every
  table referencing a customer.
- §16(e) **right to erasure** — soft-erasure overwrites PII fields
  with deterministic placeholders; AMLA-required financial records
  retained per regulatory floor.
- **Data-retention policy** — per-tenant configurable knobs +
  nightly purge job (defaults: audit 5y, notifications 1y, jobs 90d).
- **Impersonation audit propagation** — vendor support sessions
  attribute every action to both the tenant user and the platform
  operator.

### Operations

- Backup + restore scripts with per-tenant dumps + S3 offsite.
- Six operator runbooks (`docs/runbooks.md`): provisioning stuck,
  scheduler hang, license expired, missing tenant claim, pool
  exhaustion, support session, DSAR procedure.
- Sentry per-tenant tagging, structured JSON logs with PII
  redaction, health probes (liveness + readiness).
- One-command bootstrap (`pnpm start`).

### Testing

- 65 API tests, 39 DB tests — all green at tag time.
- Cross-tenant isolation unit tests (DSN shape + `resolveTenant`
  reject/accept matrix). End-to-end isolation smoke is the
  documented manual procedure in `docs/multi-tenant-cutover.md §3`.

## §2 — Literal "go live" sequence

For an operator standing up a real tenant from this tag:

1. Read [`docs/production-deploy.md`](./production-deploy.md). 3-hour
   wall-clock walkthrough from bare cloud VM to first paying
   customer live.
2. If you're a SaaS vendor flipping `MULTI_TENANT=true` on an
   existing deploy, also read
   [`docs/multi-tenant-cutover.md`](./multi-tenant-cutover.md). §2.B
   in particular covers the schema-rename adoption.
3. Configure the §7 observability checklist (Sentry, /health/ready,
   disk, backup log) before opening to customer traffic.
4. Run the §6 restore drill against the new install — every
   quarter from then on.
5. Walk the §8 go-live checklist. All eight boxes must be checked.

For ongoing operations: [`docs/runbooks.md`](./runbooks.md).

## §3 — What's NOT in v1.0.0 (honest non-scope)

These are documented carry-overs, intentionally deferred:

- **Real Twilio + SendGrid HTTP clients.** The credential storage +
  routing decision is shippable; the actual HTTP calls are still
  stubbed (provider falls back to MOCK with a warn-log). One-file
  swap in `apps/api/src/features/system/notification-providers.ts`
  when the customer commits.
- **Stripe billing + self-serve signup.** Marketing site captures
  leads (`/public/leads`); converting a Lead → Tenant is still a
  manual click on the platform console. Premature to wire Stripe
  before paid demand.
- **`public.JobRun` / `public.ScheduledJob` cleanup in multi-tenant
  mode.** Empty dead-weight tables; can't drop without Prisma's
  `multiSchema` preview. Documented in
  `docs/multi-tenant-cutover.md §7`.
- **E2E browser tests + Postgres in CI.** Cross-tenant isolation
  proof is currently a documented manual smoke. Defensive engineering
  before there's traffic to defend against.
- **Encryption-at-rest for tenant provider credentials.** Plaintext
  columns; DB isolation = the boundary. Swap to AES-256-GCM column
  wrapper when a security review demands it.
- **Mobile app.** PWA only.
- **Multi-language.** English UI only (PH market norm is bilingual
  but English-dominant for staff-facing).

## §4 — Versioning policy from here

- **Major (2.0.0)** for breaking API or schema changes that require
  a migration the operator must read.
- **Minor (1.1.0)** for new endpoints, new permissions, new SystemConfig
  knobs, additive schema fields. Backward-compatible.
- **Patch (1.0.1)** for bug fixes + non-functional improvements.

The web app, marketing site, platform console, and API all share
the workspace root version. Individual `@loan/*` libs version
together so dependency hell stays bounded.

## §5 — Acknowledgements

The Phase 2 multi-tenant refactor — the largest single architectural
change in the project's history — was completed without breaking the
single-tenant deploy path. The canary pattern + the per-request service
wiring made the conversion mechanical across ~30 features. That's the
single most important architectural decision in this codebase; everything
else flows from it.

The compliance layer (impersonation propagation, GDPR export/erase,
retention policy) was added without disturbing the domain code. The
factory + decorator patterns paid back.

If you're reading this in production logs after something went wrong:
see `docs/runbooks.md`. Don't improvise from memory.
