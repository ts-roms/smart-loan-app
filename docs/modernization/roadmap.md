# Modernization Roadmap

Derived from the Phase 0 audit. Sequenced by risk, not by visibility.

**Governing principle** (the brief's §87, which I endorse): stability and
financial correctness over architectural purity. The repository is in better
shape than the brief assumes — money typing is already correct and layering
already matches the target. The work that remains is about _guarantees_, and it
is smaller and more valuable than a framework migration.

_Amended 14 Aug._ This section used to claim "no listed feature is missing".
After checking ten previously-unverified phases against code
(`phase-verification.md`), that is no longer true and probably never was: §52's
credit dashboard has nothing behind it, notification providers are all
`console.log`, and six catalogued notification events never fire. The principle
still holds; the flattering summary attached to it did not survive being
checked.

---

## Full roadmap — §86-I column set

The brief specifies nine columns. This is that table; the phase sections below
carry the reasoning.

| Phase  | Objective                                                                                           | Files                                                                                         | Database Changes                           | API Changes                         | Frontend Changes                | Tests          | Risk                                                | Dependencies      |
| ------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- | ------------------------------- | -------------- | --------------------------------------------------- | ----------------- |
| 1.1 ✅ | Detect duplicate journal entries                                                                    | `libs/db/scripts/detect-duplicate-journal-entries.mjs`                                        | none (read-only)                           | none                                | none                            | manual run     | none                                                | —                 |
| 1.2 ✅ | Journal idempotency                                                                                 | `accounting.repository.ts`, `schema.prisma`                                                   | `UNIQUE(source,sourceRefType,sourceRefId)` | none                                | none                            | 6              | low — needs 1.1 clean first                         | 1.1               |
| 1.3 ✅ | One-shot loan transitions                                                                           | `loan.repository.ts`                                                                          | none                                       | none (409 unchanged)                | none                            | covered by 2.1 | low                                                 | —                 |
| 1.4 ✅ | Payment idempotency                                                                                 | `loan.repository.ts`, `loans.routes.ts`, `schemas.ts`                                         | `LoanPayment.idempotencyKey` UNIQUE        | `Idempotency-Key` header (additive) | none                            | 6              | medium                                              | —                 |
| 1.5 ✅ | Job slot exclusivity                                                                                | `job.repository.ts`                                                                           | none                                       | none                                | none                            | 4              | low                                                 | —                 |
| 1.6 ✅ | Decision single-shot                                                                                | `loan.repository.ts`, `loans.controller.ts`                                                   | none                                       | 409 `LoanNotDecidable` (new)        | error surfaced in decide dialog | 15             | low                                                 | 1.3 idiom         |
| 2.1 ✅ | Financial invariants                                                                                | `libs/accounting/src/invariants.test.ts`, `libs/loans/src/ledger-position.invariants.test.ts` | none                                       | none                                | none                            | 26             | none                                                | 1.x               |
| 2.2 ✅ | Golden corpus                                                                                       | `libs/loans/src/golden-corpus.test.ts`                                                        | none                                       | none                                | none                            | 49             | none                                                | —                 |
| 2.3 ✅ | Standing reconciliation                                                                             | `libs/db/src/lib/reconciliation.ts`, `jobs.ts`                                                | none                                       | `/accounting/reconciliation` read   | banner on trial balance         | ~8             | low                                                 | 2.1               |
| 2.4 ✅ | FK CASCADE → RESTRICT                                                                               | `schema.prisma`                                                                               | 12 FK rule changes across 2 migrations     | none                                | none                            | ~2             | **medium** — must confirm no seed relies on cascade | archive `3a9d0fa` |
| 2.5 ✅ | Webhook idempotency                                                                                 | `payments.routes.ts`                                                                          | reuse `idempotencyKey`                     | provider callback contract          | none                            | ~6             | low                                                 | 1.4               |
| 3.1 ✅ | Object storage                                                                                      | `libs/storage/`, `uploads/`, `documents/`                                                     | none needed — keys derive from the URL     | signed `/uploads/` route            | upload/preview components       | ~10            | ~~high~~ → low; S3 path never run live              | backup drill      |
| 3.2 ✅ | Playwright + 6 journeys                                                                             | `apps/web/e2e`                                                                                | none                                       | none                                | none                            | 6              | low                                                 | —                 |
| 3.3 ✅ | Enable CSP                                                                                          | `app.ts`                                                                                      | none                                       | headers                             | may break inline styles         | smoke          | medium                                              | 3.2               |
| 3.4 ✅ | OpenAPI schemas                                                                                     | all `*.routes.ts`                                                                             | none                                       | spec only                           | none                            | contract       | low                                                 | —                 |
| 3.5 ✅ | Restore drill                                                                                       | `docs/`, `deploy/`                                                                            | none                                       | none                                | none                            | manual         | none                                                | —                 |
| 4.1 ✅ | Nx module boundaries                                                                                | `nx.json`, `eslint.config.mjs`                                                                | none                                       | none                                | none                            | lint           | low                                                 | —                 |
| 4.2 ✅ | Index from query plans                                                                              | `schema.prisma`                                                                               | indexes                                    | none                                | none                            | perf           | low                                                 | realistic data    |
| 4.3 ✅ | Rule + scorecard versioning                                                                         | `libs/decisioning`, `schema.prisma`                                                           | `DecisionRule.version`, `effectiveFrom/To` | rule CRUD                           | rule editor shows version       | ~10            | medium                                              | —                 |
| 4.4    | Consolidated exposure                                                                               | `libs/loans`, `customers/`                                                                    | none                                       | `/customers/:id/exposure`           | Customer 360 tab                | ~6             | low                                                 | —                 |
| 4.5 ✅ | Next.js pilot (marketing only)                                                                      | `apps/marketing-next`                                                                         | none                                       | none                                | full app                        | E2E            | medium                                              | 3.2               |
| 5.x    | Collection scoring ✅, roll-rate ✅, profitability ✅, unified collateral (open)                    | various                                                                                       | new models                                 | new reads                           | new pages                       | TBD            | low                                                 | 2.x               |
| 6.x    | **Verified-open items** — see the Phase 6 table below (19 steps from the 14 Aug phase verification) | various                                                                                       | 6.4, 6.8 need migrations                   | 6.10, 6.14 add endpoints            | 6.14–6.17                       | see below      | 6.1/6.4–6.7 are P1                                  | —                 |

---

## Phase 1 — Financial guarantees (P0) — ✅ COMPLETE

Shipped in `64e17ff`, `fa5e3fb`, `6359027`, `7564fa8`. Every defect below is now
prevented by the database rather than by a check a second request can walk past.

| Step                                                           | Status                                | Commit    |
| -------------------------------------------------------------- | ------------------------------------- | --------- |
| 1.1 Duplicate-journal detection script                         | ✅ clean on dev (27 entries, 0 dupes) | `64e17ff` |
| 1.2 Unique index + insert-and-catch `postIfAbsent`             | ✅                                    | `64e17ff` |
| 1.3 Conditional-update claims (disburse, closeEarly, writeOff) | ✅                                    | `fa5e3fb` |
| 1.4 Payment idempotency key                                    | ✅                                    | `7564fa8` |
| 1.5 Job slot claim                                             | ✅                                    | `6359027` |

**One finding the audit understated.** 1.5 was filed as "needs a lock before
multi-process deploy". Reading the code, `nextRunAt` advanced only _after_ a job
finished and `setInterval` does not wait for an async tick — so any job slower
than the tick interval restarted itself, on one process, with no scaling
involved. For interest accrual that is the same accrual posted twice.

**One deviation from the plan.** 1.5 proposed `pg_try_advisory_lock`. A
session-level advisory lock is tied to a connection and Prisma pools
connections, so the lock and its release can land on different ones. A
conditional UPDATE needs no lock, survives a process dying mid-job, and matches
the claim pattern used for loan transitions.

Original plan, for the record:

| Step | Change                                                                                                                                                           | Files                                                  | DB change | Risk                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------- | ------------------------ |
| 1.1  | Detect existing duplicate journal entries                                                                                                                        | new script under `libs/db/scripts`                     | read-only | none                     |
| 1.2  | `@@unique([source, sourceRefType, sourceRefId])` on `JournalEntry`; rewrite `postIfAbsent` to insert-and-catch-P2002                                             | `schema.prisma`, `accounting.repository.ts`            | migration | low — must run 1.1 first |
| 1.3  | Conditional-update state transitions (`UPDATE ... WHERE status = ?`, treat 0 rows as refusal) for disburse, and the same pattern for other financial transitions | `loan.repository.ts`                                   | none      | low                      |
| 1.4  | `Idempotency-Key` on payment + disbursement endpoints, persisted with a unique constraint; repeat returns the original result                                    | `features/payments`, `features/loans`, `schema.prisma` | migration | medium                   |
| 1.5  | `pg_try_advisory_lock` around scheduled jobs                                                                                                                     | `libs/jobs`                                            | none      | low                      |

**Verification for the whole phase:** concurrent-request tests that fire two
identical payments / disbursements / accruals simultaneously and assert exactly
one financial effect.

## Phase 2 — Proof (P1) — ✅ COMPLETE

Shipped in `e1620a1` (invariants) and this commit (golden corpus).

| Step                                           | Status                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Invariant tests                            | ✅ 26 tests across `libs/accounting` and `libs/loans`                                                                                                                                        |
| 2.2 Golden corpus                              | ✅ 8 scenarios, 49 assertions                                                                                                                                                                |
| 2.3 Standing reconciliation job                | ✅ `libs/db/src/lib/reconciliation.ts` — 5 checks, nightly 04:30, throws on a finding                                                                                                        |
| 2.4 Contribution/Savings FK CASCADE → RESTRICT | ✅ and wider than written — `20260811160000_coop_money_restrict` fixed the two named here; `20260814090000_financial_record_restrict` closed ten more relations that reached money on delete |

**The corpus carries two levels of authority, and the file says so.** Half its
assertions are closed-form — first-period interest, flat interest, the annuity
formula, principal summing exactly to the loan — and if the code disagrees with
those, the code is wrong. The other half are fingerprints captured from the
current implementation: they prove behaviour has not _changed_, which is what a
refactor needs, but they do not prove it is _right_. Replacing them with worked
examples from signed loan documents is the one change that would make the corpus
authoritative rather than merely protective.

Original plan:

| Step | Change                                                                                                                                         | Why                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 2.1  | Invariant tests: debits==credits; allocations <= payment; outstanding identity; reversal offsets original; repeated idempotency key is a no-op | Locks Phase 1 in permanently                             |
| 2.2  | Golden financial corpus per product, expected schedules committed                                                                              | **Precondition for any calculation change**              |
| 2.3  | Standing reconciliation job (subledger vs GL, per period), failing loudly                                                                      | Turns a manual trial balance into a continuous assertion |
| 2.4  | `Contribution` / `SavingsTransaction` FK: CASCADE → RESTRICT                                                                                   | Database enforces what the service already promises      |

## Phase 3 — Durability and operations (P1/P2) — ONE ITEM LEFT

| Step | Change                                                                | Status                                                                                                                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.0  | Frontend component-test harness + 4 suites over the costly surfaces   | ✅ 45 tests                                                                                                                                                                                                                                                                                                            |
| 3.1  | Object storage (S3/MinIO) for uploads; DB keeps metadata; signed URLs | ✅ `libs/storage` — local disk default, S3 adapter behind `STORAGE_DRIVER`, no migration needed. Deliberately no `getSignedUrl`: bytes keep leaving through the API so the `/uploads/` sandbox CSP and `nosniff` still apply. The S3 path has never run live — a bucket, an IAM principal and a round-trip test remain |
| 3.2  | Playwright + 6 journeys against a live stack                          | ✅ 21 read assertions **plus the write journey**: apply→2-person approval→disburse→pay, all UI, closing with reconciliation green on a scratch DB it creates and drops. Found a real defect (chain skipped the KYC re-check, now fixed)                                                                                |
| 3.3  | Enable CSP in production                                              | ✅ API (`/uploads/` sandboxed, JSON `default-src 'none'`) **and** SPA (build-time meta + `frame-ancestors` from nginx). `style-src` still needs `unsafe-inline` — Radix; documented                                                                                                                                    |
| 3.4  | Attach zod-derived schemas to routes for real OpenAPI                 | ✅ **328 of 339** operations, ratcheted by a test. The other 11 are enumerated exceptions, not omissions: 8 stream `application/pdf`, 2 answer a literal top-level `null`, 1 dispatches a row shape that varies by report type. Every group verified 401-before-400 live                                               |
| 3.5  | Documented restore drill                                              | ✅ written **and run** — and it FAILED on an unpatched host (pg_dump 18 vs server 16). See disaster-recovery.md                                                                                                                                                                                                        |

**Phase 3 is done.** OpenAPI coverage finished at 328 of 339 with the
remaining 11 enumerated as exceptions rather than left vague. Object storage
(3.1) has shipped its engineering half; what is left there is provisioning a
bucket, not writing code.

Several Phase 4 and Phase 5 items landed early because they were the
highest-value work available once the P1 queue emptied: module boundaries
(4.1), consolidated exposure (4.4), rule and scorecard versioning (4.3), plus
§29 collection priority scoring and §30 roll-rate analysis from Phase 5. The
phases have not run in order and this records that rather than implying they
did.

## Phase 4 — Enterprise depth (P2)

| Step | Change                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | ✅ Nx module-boundary tags + `@nx/enforce-module-boundaries` — both axes bite; caveat: a new lib is invisible until `nx reset`                                                                                                                                                                          |
| 4.2  | ✅ Query plans from a 1.3M-row scratch book — six indexes added, each with before/after plans; five rejected with reasons; four N+1/whole-book findings recorded. See query-performance.md                                                                                                              |
| 4.3  | ✅ GAP-15 verified (restructure links a new loan, never mutates a schedule) · ✅ GAP-18 rule versioning (`20260811180000`) · ✅ scorecard versioning (`20260812090000`)                                                                                                                                 |
| 4.4  | ✅ Consolidated customer exposure (GAP-29) — derived, no migration; written-off reported separately from the live total                                                                                                                                                                                 |
| 4.5  | ✅ Pilot shipped side-by-side as `apps/marketing-next` — 8 routes, URLs preserved, zero client JS on static pages. Headline finding: `libs/ui`'s barrel fails RSC builds and its classes are bound to the console's token system. Moves §38 from "defer, unknown cost" to "defer, and here is the cost" |

## Phase 5 — Intelligence (P3)

✅ Collection priority scoring (GAP-23), ✅ roll-rate analysis (GAP-24),
✅ product profitability (GAP-30). Remaining: unified collateral model
(GAP-26) and expanded fraud signals — both genuinely valuable, neither
urgent, both safe to defer.

## Phase 6 — Verified-open items (from `phase-verification.md`, 14 Aug)

Ten master-prompt phases were checked against code for the first time. These are
the items that came back genuinely open. **They are listed here because being
absent from the roadmap is how work stays invisible** — the same reason payment
allocation (§26) and F4 pagination went untracked for so long.

| Step | Change                                                                                                                                                                                          | Risk | Est.  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| 6.1  | **ECL re-run guard + transaction.** Re-running a period double-posts the provision movement (`postIfAbsent` keys on a fresh `EclRun.id`) while `EclRunsPage.tsx:47` says "safe to re-run"       | P1   | 1 d   |
| 6.2  | **Notification outbox + retry/DLQ**, migrating the six inline request-path dispatches. Must precede any real provider — today a hung socket would hang a disbursement response                  | P1   | 3–5 d |
| 6.3  | **Real notification adapters** (SendGrid/SES, Twilio/Semaphore, push + device tokens). Every provider is currently `console.log`                                                                | P2   | 3–4 d |
| 6.4  | **Audit forensic fields** — `ipAddress`, `userAgent`, `requestId` on `AuditEvent`, populated from the request. Pairs with 6.9                                                                   | P1   | 1–2 d |
| 6.5  | **Audit the unaudited financial actions** — disburse, payment, payment reversal, journal post, period close, login/logout/failed login                                                          | P1   | 1.5 d |
| 6.6  | **Retention carve-out for financial + impersonation audit classes**, and make the AMLA floor a hard refusal for those classes rather than a flag                                                | P1   | 1 d   |
| 6.7  | **KYC/upload purge on erasure** — `compliance.service.ts:406` promises the operator a deletion that no job performs                                                                             | P1   | 1–2 d |
| 6.8  | **ECL assumption versioning** (`EclAssumptionSet` + FK snapshot on `EclRun`) and PD/LGD writable via API; scope with the per-loan `EclRunLine` history that also unblocks by-product/by-vintage | P2   | 3–4 d |
| 6.9  | **Request/correlation ID** — ingest, propagate, log. Currently only Fastify's per-process `req.id`; no `x-request-id` anywhere                                                                  | P2   | 1 d   |
| 6.10 | **Metrics endpoint** — there is no `/metrics`, no Prometheus client, no counters anywhere                                                                                                       | P2   | 1 d   |
| 6.11 | **Apply log redaction in all environments** — the pino `redact` block is inside the `isProd` ternary, and dev additionally logs full Prisma queries                                             | P2   | 1 h   |
| 6.12 | **Advisory lock on the scheduler tick.** Correctness currently rests on `numReplicas: 1`                                                                                                        | P2   | 0.5 d |
| 6.13 | **Assistant regression test** — advisory-only (no tools, no write path) is guaranteed by code reading alone; nothing stops a future tool array                                                  | P2   | 0.5 d |
| 6.14 | **Borrower notification inbox** + scoped list endpoint. Also fixes `auth.service.ts:533-536`, whose unseen-count query has no user or customer scoping                                          | P2   | 1.5 d |
| 6.15 | **Credit dashboard** (approval rate, score/tier distribution, decision funnel) — the only one of §52's four families with nothing behind it; all source data exists                             | P2   | 3–5 d |
| 6.16 | **Replace synthesized dashboard sparklines** with real timeseries — `synthCumulative`/`approximateNplTrend` fabricate the trend lines beside the hero KPIs                                      | P2   | 2–3 d |
| 6.17 | Collections metrics: recovery rate, PTP performance, collector performance, and a page to hang them on                                                                                          | P3   | 4–5 d |
| 6.18 | **Staging tier + CD.** Only dev and prod exist; CI never builds, pushes or deploys an image                                                                                                     | P3   | 2–3 d |
| 6.19 | **Effective interest rate computation.** No EIR/IRR exists in `libs/`; flat/add-on is the actual product. **Scope must be set by a compliance professional first** — see §70                    | ?    | 2–3 d |

Not scheduled here, deliberately: CIC, BSP and SEC reporting, AMLA CTR/STR, and
consent/DPO records. All are absent from the code, all are externally specified,
and none should be estimated by engineering before a compliance professional
scopes them (§70). They are inventoried in `phase-verification.md` §70 so they
are visible without being pretend-planned.

**One process note.** `@loan/api:test` and `@loan/web:test` were both flagged
flaky by Nx during this audit — the same suite failed 2 tests under parallel load
and passed 438/438 on a clean re-run. Not scheduled as a step because it needs
diagnosis before it needs a plan, but a financial system whose test suite is
load-sensitive will eventually mislead someone about a real regression.

---

## What I recommend _against_

| Proposal                                    | Recommendation          | Reason                                                                                                                          |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Migrate Fastify → NestJS                    | **No**                  | Touches 319 routes, changes no behaviour, on a financial system. The DI benefit already exists in a better, tenant-safe form.   |
| Replace Prisma / PostgreSQL                 | **No**                  | No defect found in either.                                                                                                      |
| Row-level tenancy                           | **No**                  | Schema-per-tenant with an isolation test is stronger.                                                                           |
| Big-bang Next.js migration                  | **No**                  | 68 routes, 148 components, 1 frontend test. Pilot on marketing, re-evaluate.                                                    |
| Refactor financial calculations for clarity | **Not until Phase 2.2** | Existing arithmetic may be accountingly significant. Golden tests first.                                                        |
| Add Redis "because enterprise"              | **Only with a reason**  | The in-process scheduler is a documented decision. An advisory lock (1.5) solves the actual problem without new infrastructure. |

---

## Immediate next step

_(This section pointed at Phase 2.1 until 14 Aug, which the table above has
marked ✅ COMPLETE for some time. Corrected by the phase-verification audit —
and it is worth noting that a stale "next step" is how a tracker misdirects work
most cheaply.)_

**6.1 — the ECL re-run guard.** It is the only item on this roadmap that puts
wrong numbers into the general ledger, it is a day's work, and the UI currently
tells operators the opposite of the truth about it.

Then **6.4** (audit forensic fields) and **6.2** (notification outbox), in that
order: 6.4 is a control gap that grows more expensive to backfill the longer
audit rows accumulate without it, and 6.2 must land before any real notification
provider is configured, not after.

**Deployment note for Phase 1.** Run
`libs/db/scripts/detect-duplicate-journal-entries.mjs` against each environment
BEFORE `migrate deploy`. The unique index cannot be created while duplicates
exist, and discovering that mid-migration on production is the wrong moment. The
remedy for any duplicate found is a reversing entry, not a delete.
