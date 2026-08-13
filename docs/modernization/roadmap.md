# Modernization Roadmap

Derived from the Phase 0 audit. Sequenced by risk, not by visibility.

**Governing principle** (the brief's §87, which I endorse): stability and
financial correctness over architectural purity. The repository is in better
shape than the brief assumes — no listed feature is missing, money typing is
already correct, layering already matches the target. The work that remains is
about _guarantees_, and it is smaller and more valuable than a framework
migration.

---

## Full roadmap — §86-I column set

The brief specifies nine columns. This is that table; the phase sections below
carry the reasoning.

| Phase  | Objective                                                        | Files                                                                                         | Database Changes                           | API Changes                         | Frontend Changes                | Tests          | Risk                                                | Dependencies      |
| ------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------- | ------------------------------- | -------------- | --------------------------------------------------- | ----------------- |
| 1.1 ✅ | Detect duplicate journal entries                                 | `libs/db/scripts/detect-duplicate-journal-entries.mjs`                                        | none (read-only)                           | none                                | none                            | manual run     | none                                                | —                 |
| 1.2 ✅ | Journal idempotency                                              | `accounting.repository.ts`, `schema.prisma`                                                   | `UNIQUE(source,sourceRefType,sourceRefId)` | none                                | none                            | 6              | low — needs 1.1 clean first                         | 1.1               |
| 1.3 ✅ | One-shot loan transitions                                        | `loan.repository.ts`                                                                          | none                                       | none (409 unchanged)                | none                            | covered by 2.1 | low                                                 | —                 |
| 1.4 ✅ | Payment idempotency                                              | `loan.repository.ts`, `loans.routes.ts`, `schemas.ts`                                         | `LoanPayment.idempotencyKey` UNIQUE        | `Idempotency-Key` header (additive) | none                            | 6              | medium                                              | —                 |
| 1.5 ✅ | Job slot exclusivity                                             | `job.repository.ts`                                                                           | none                                       | none                                | none                            | 4              | low                                                 | —                 |
| 1.6 ✅ | Decision single-shot                                             | `loan.repository.ts`, `loans.controller.ts`                                                   | none                                       | 409 `LoanNotDecidable` (new)        | error surfaced in decide dialog | 15             | low                                                 | 1.3 idiom         |
| 2.1 ✅ | Financial invariants                                             | `libs/accounting/src/invariants.test.ts`, `libs/loans/src/ledger-position.invariants.test.ts` | none                                       | none                                | none                            | 26             | none                                                | 1.x               |
| 2.2 ✅ | Golden corpus                                                    | `libs/loans/src/golden-corpus.test.ts`                                                        | none                                       | none                                | none                            | 49             | none                                                | —                 |
| 2.3    | Standing reconciliation                                          | new job in `libs/jobs` + `libs/db`                                                            | none                                       | `/accounting/reconciliation` read   | banner on trial balance         | ~8             | low                                                 | 2.1               |
| 2.4    | FK CASCADE → RESTRICT                                            | `schema.prisma`                                                                               | 2 FK rule changes                          | none                                | none                            | ~2             | **medium** — must confirm no seed relies on cascade | archive `3a9d0fa` |
| 2.5    | Webhook idempotency                                              | `payments.routes.ts`                                                                          | reuse `idempotencyKey`                     | provider callback contract          | none                            | ~6             | low                                                 | 1.4               |
| 3.1    | Object storage                                                   | `app.ts`, `uploads/`, `documents/`                                                            | `Document.storageKey`                      | signed-URL endpoints                | upload/preview components       | ~10            | **high** — data migration of existing files         | backup drill      |
| 3.2    | Playwright + 6 journeys                                          | new `apps/web/e2e`                                                                            | none                                       | none                                | none                            | 6              | low                                                 | —                 |
| 3.3    | Enable CSP                                                       | `app.ts`                                                                                      | none                                       | headers                             | may break inline styles         | smoke          | medium                                              | 3.2               |
| 3.4    | OpenAPI schemas                                                  | all `*.routes.ts`                                                                             | none                                       | spec only                           | none                            | contract       | low                                                 | —                 |
| 3.5    | Restore drill                                                    | `docs/`, `deploy/`                                                                            | none                                       | none                                | none                            | manual         | none                                                | —                 |
| 4.1    | Nx module boundaries                                             | `nx.json`, project configs                                                                    | none                                       | none                                | none                            | lint           | low                                                 | —                 |
| 4.2    | Index from query plans                                           | `schema.prisma`                                                                               | indexes                                    | none                                | none                            | perf           | low                                                 | realistic data    |
| 4.3    | Rule + scorecard versioning                                      | `libs/decisioning`, `schema.prisma`                                                           | `DecisionRule.version`, `effectiveFrom/To` | rule CRUD                           | rule editor shows version       | ~10            | medium                                              | —                 |
| 4.4    | Consolidated exposure                                            | `libs/loans`, `customers/`                                                                    | none                                       | `/customers/:id/exposure`           | Customer 360 tab                | ~6             | low                                                 | —                 |
| 4.5    | Next.js pilot (marketing only)                                   | `apps/marketing`                                                                              | none                                       | none                                | full app                        | E2E            | medium                                              | 3.2               |
| 5.x    | Collection scoring, roll-rate, profitability, unified collateral | various                                                                                       | new models                                 | new reads                           | new pages                       | TBD            | low                                                 | 2.x               |

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

| Step                                           | Status                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| 2.1 Invariant tests                            | ✅ 26 tests across `libs/accounting` and `libs/loans` |
| 2.2 Golden corpus                              | ✅ 8 scenarios, 49 assertions                         |
| 2.3 Standing reconciliation job                | not started                                           |
| 2.4 Contribution/Savings FK CASCADE → RESTRICT | not started                                           |

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

| Step | Change                                                                | Status                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.0  | Frontend component-test harness + 4 suites over the costly surfaces   | ✅ 45 tests                                                                                                                                                                         |
| 3.1  | Object storage (S3/MinIO) for uploads; DB keeps metadata; signed URLs | ⬜ needs a bucket + credentials; backup now archives `UPLOADS_DIR`, so it is planned, not urgent                                                                                    |
| 3.2  | Playwright + 6 journeys against a live stack                          | ✅ 21 assertions, read-only. A WRITE journey (apply→approve→disburse→pay against a disposable DB) is in flight                                                                      |
| 3.3  | Enable CSP in production                                              | ✅ API (`/uploads/` sandboxed, JSON `default-src 'none'`) **and** SPA (build-time meta + `frame-ancestors` from nginx). `style-src` still needs `unsafe-inline` — Radix; documented |
| 3.4  | Attach zod-derived schemas to routes for real OpenAPI                 | ◐ **112 of 337** operations, ratcheted by a test. Mechanism, bearer scheme and status conventions done; ~225 routes remain                                                          |
| 3.5  | Documented restore drill                                              | ✅ written **and run** — and it FAILED on an unpatched host (pg_dump 18 vs server 16). See disaster-recovery.md                                                                     |

**Phase 3 is one item from done** — only OpenAPI coverage remains inside it,
and that is a per-feature grind rather than a design problem. Object storage
(3.1) is blocked on a bucket and credentials, not on engineering.

Several Phase 4 and Phase 5 items landed early because they were the
highest-value work available once the P1 queue emptied: module boundaries
(4.1), consolidated exposure (4.4), rule and scorecard versioning (4.3), plus
§29 collection priority scoring and §30 roll-rate analysis from Phase 5. The
phases have not run in order and this records that rather than implying they
did.

## Phase 4 — Enterprise depth (P2)

| Step | Change                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | ✅ Nx module-boundary tags + `@nx/enforce-module-boundaries` — both axes bite; caveat: a new lib is invisible until `nx reset`                                          |
| 4.2  | Query plans for the 10 slowest endpoints; index from evidence — ⬜                                                                                                      |
| 4.3  | ✅ GAP-15 verified (restructure links a new loan, never mutates a schedule) · ✅ GAP-18 rule versioning (`20260811180000`) · ✅ scorecard versioning (`20260812090000`) |
| 4.4  | ✅ Consolidated customer exposure (GAP-29) — derived, no migration; written-off reported separately from the live total                                                 |
| 4.5  | Next.js pilot on `apps/marketing` only                                                                                                                                  |

## Phase 5 — Intelligence (P3)

Collection priority scoring (GAP-23), roll-rate analysis (GAP-24), unified
collateral model (GAP-26), product profitability (GAP-30), expanded fraud
signals. All genuinely valuable, none urgent, all safe to defer.

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

Phase 2.1 — the remaining invariant tests. Phase 1 shipped with three of them
already (journal idempotency, job slots, payment idempotency); what is still
missing is the set that guards the arithmetic rather than the concurrency:
debits == credits per entry and period, allocations <= payment amount, the
outstanding-principal identity, and a reversal exactly offsetting its original.

Then 2.2, the golden corpus — which remains the precondition for touching any
calculation.

**Deployment note for Phase 1.** Run
`libs/db/scripts/detect-duplicate-journal-entries.mjs` against each environment
BEFORE `migrate deploy`. The unique index cannot be created while duplicates
exist, and discovering that mid-migration on production is the wrong moment. The
remedy for any duplicate found is a reversing entry, not a delete.
