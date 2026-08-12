# Modernization Gap Analysis

Every target capability from the brief, categorised against what the repository
actually contains. Status vocabulary is the brief's own.

**Headline: no listed _feature_ is missing.** The gaps are _guarantees_ —
concurrency, idempotency, storage durability, test depth — plus one genuine
greenfield item (Next.js). That reframing is what the roadmap is built on.

---

## Financial core (P0)

| #      | Capability                                        | Current implementation                                | Status                  | Risk   |
| ------ | ------------------------------------------------- | ----------------------------------------------------- | ----------------------- | ------ |
| GAP-01 | Money as NUMERIC/Decimal                          | 79 Decimal, all with precision; 0 monetary floats     | **EXISTS — GOOD**       | —      |
| GAP-02 | Financial ops in transactions                     | `$transaction` throughout `libs/db/repositories`      | **EXISTS — GOOD**       | —      |
| GAP-03 | Immutable financial history                       | reverse-don't-delete; journal reversal is first-class | **EXISTS — GOOD**       | —      |
| GAP-04 | Idempotency (payments, disbursement, webhooks)    | `postIfAbsent` only, unbacked by a constraint         | **MISSING**             | **P0** |
| GAP-05 | Concurrency control (locking, unique constraints) | state guards present; **no `FOR UPDATE` anywhere**    | **PARTIAL / DANGEROUS** | **P0** |
| GAP-06 | Standing reconciliation invariant                 | repair scripts exist; no continuous assertion         | **PARTIAL**             | P1     |

Detail and fixes: `financial-engine-audit.md` (P0-1 … P1-7).

## Infrastructure

| #      | Capability                     | Current                                          | Status                       | Risk             |
| ------ | ------------------------------ | ------------------------------------------------ | ---------------------------- | ---------------- |
| GAP-07 | Object storage (S3/MinIO)      | local disk + static plugin                       | **MISSING**                  | **P1**           |
| GAP-08 | Redis / durable queue          | in-process `setInterval`, deliberate             | **PARTIAL — by design**      | P1 at >1 process |
| GAP-09 | Job scheduler distributed lock | none                                             | **MISSING**                  | P1               |
| GAP-10 | Observability                  | Sentry wired; structured logging via Fastify     | **EXISTS — NEEDS HARDENING** | P2               |
| GAP-11 | Backup / DR drill              | `docs/runbooks.md`, `production-deploy.md` exist | **PARTIAL**                  | P2               |

**On GAP-07:** this is the one infrastructure gap with real consequence today.
KYC identity documents on a container filesystem means no durability, no
retention enforcement on the blobs, no signed-URL expiry, and horizontal scaling
breaks document access. It is a security finding (S-1) and an operational one.

**On GAP-08/09:** the in-process scheduler is a _documented decision_, not an
oversight, and the handler signature was kept queue-shaped so swapping is a
runtime change. It is correct for single-process deployment. It becomes a
correctness bug the moment a second API process runs — every job fires twice,
concurrently, which combined with GAP-04 is a duplicate-posting engine.

## Lending domain

| #      | Capability                                     | Current                                              | Status                      |
| ------ | ---------------------------------------------- | ---------------------------------------------------- | --------------------------- |
| GAP-12 | Config-driven loan products                    | `LoanProduct.config`, per-product KYC questionnaires | **EXISTS — GOOD**           |
| GAP-13 | Salary / housing / auto / motorcycle / lease   | all five present                                     | **EXISTS**                  |
| GAP-14 | Amortization (methods, frequencies)            | `libs/loans`, 6 test files                           | **EXISTS — best-tested**    |
| GAP-15 | Immutable schedule versions                    | schedules mutate in place on restructure             | **NEEDS VERIFICATION**      |
| GAP-16 | Credit scoring (catalog-driven)                | `libs/credit-scoring` + admin catalog                | **EXISTS — GOOD**           |
| GAP-17 | Decisioning rules                              | `libs/decisioning`, admin-editable                   | **EXISTS**                  |
| GAP-18 | Rule versioning + effective dating             | not observed                                         | **NEEDS VERIFICATION**      |
| GAP-19 | Explainable decisions                          | verdict + reason + matched rule returned             | **EXISTS**                  |
| GAP-20 | Approval matrix                                | `LoanApprovalStep` chain, configurable               | **EXISTS**                  |
| GAP-21 | Payment allocation order                       | `libs/payments`                                      | **EXISTS**                  |
| GAP-22 | Collections, PTP, demand letters, repossession | dedicated features                                   | **EXISTS — GOOD**           |
| GAP-23 | Collection priority scoring                    | not observed                                         | **MISSING** (P3)            |
| GAP-24 | Roll-rate analysis                             | not observed                                         | **MISSING** (P3)            |
| GAP-25 | Restructure / refinance / renewal              | present incl. renewal settle-on-disburse             | **EXISTS**                  |
| GAP-26 | Unified collateral model                       | vehicle + property as separate models                | **PARTIAL** (P3)            |
| GAP-27 | Double-entry GL, period close, reconciliation  | `libs/accounting` + features                         | **EXISTS — GOOD**           |
| GAP-28 | IFRS-9 ECL staging                             | `ecl.repository.ts`, `features/ecl`                  | **EXISTS**                  |
| GAP-29 | Consolidated customer exposure                 | per-loan; consolidated view not confirmed            | **NEEDS VERIFICATION** (P2) |
| GAP-30 | Product profitability                          | not observed                                         | **MISSING** (P3)            |

GAP-15 and GAP-18 are marked _needs verification_ rather than missing: I did not
read the restructure and rule-evaluation paths closely enough to assert either
way, and the brief is explicit that nothing should be called missing until it has
been searched for. These are the first two items for a Phase 0.5 follow-up.

## Platform, security, compliance

| #      | Capability                                     | Current                                         | Status                   |
| ------ | ---------------------------------------------- | ----------------------------------------------- | ------------------------ |
| GAP-31 | Multi-tenancy + isolation                      | schema-per-tenant, tested                       | **EXISTS — GOOD**        |
| GAP-32 | RBAC / delegation / 2FA                        | permission-based, DB-resolved                   | **EXISTS — GOOD**        |
| GAP-33 | Audit trail incl. impersonation                | append-only, operator identity separate         | **EXISTS — GOOD**        |
| GAP-34 | Data Privacy (DSAR export, erasure, retention) | `features/compliance` + UI                      | **EXISTS — GOOD**        |
| GAP-35 | AMLA screening                                 | `libs/screening`                                | **EXISTS**               |
| GAP-36 | DORSI compliance                               | `features/dorsi`, fail-closed when unconfigured | **EXISTS — GOOD**        |
| GAP-37 | CSP enabled                                    | `contentSecurityPolicy: false`                  | **NEEDS HARDENING** (P2) |
| GAP-38 | Secrets management documented                  | `.env`                                          | **PARTIAL** (P2)         |

## Frontend

| #      | Capability                          | Current                    | Status            |
| ------ | ----------------------------------- | -------------------------- | ----------------- |
| GAP-39 | Next.js App Router                  | **none — three Vite SPAs** | **MISSING** (P2)  |
| GAP-40 | Shared UI / api-client / types libs | all four extracted         | **EXISTS — GOOD** |
| GAP-41 | PWA                                 | `vite-plugin-pwa`          | **EXISTS**        |
| GAP-42 | Frontend tests                      | 1 file / 148 components    | **MISSING** (P1)  |
| GAP-43 | E2E suite                           | shell smoke script only    | **MISSING** (P2)  |

## Testing

| #      | Capability                         | Current                          | Status                                         |
| ------ | ---------------------------------- | -------------------------------- | ---------------------------------------------- |
| GAP-44 | Unit/integration tests             | 47 files, financial libs deepest | **EXISTS — NEEDS EXPANSION**                   |
| GAP-45 | Financial property/invariant tests | none                             | **MISSING** (P1)                               |
| GAP-46 | Golden financial corpus            | none                             | **MISSING** (P1) — blocks all calculation work |
| GAP-47 | Coverage reporting                 | none                             | **MISSING** (P3)                               |

---

## The seven things that actually matter

Ordered by (risk × likelihood) ÷ effort:

1. **GAP-04 / P0-1** — unique constraint on `(source, sourceRefType, sourceRefId)`. Small.
2. **GAP-05 / P0-3** — conditional-update state transitions instead of check-then-act. Small.
3. **GAP-04 / P0-2** — idempotency keys on payment and disbursement. Medium.
4. **GAP-45** — invariant tests that lock 1–3 in permanently. Medium.
5. **GAP-46** — golden corpus, before any arithmetic is touched. Medium.
6. **GAP-07** — object storage for KYC documents. Medium.
7. **GAP-09** — advisory lock on the scheduler, before any multi-process deploy. Small.

Everything else — including the entire Next.js migration — is downstream of these.
