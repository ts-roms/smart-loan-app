# Modernization Roadmap

Derived from the Phase 0 audit. Sequenced by risk, not by visibility.

**Governing principle** (the brief's §87, which I endorse): stability and
financial correctness over architectural purity. The repository is in better
shape than the brief assumes — no listed feature is missing, money typing is
already correct, layering already matches the target. The work that remains is
about _guarantees_, and it is smaller and more valuable than a framework
migration.

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

## Phase 2 — Proof (P1) — 2.1 and 2.2 ✅

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

## Phase 3 — Durability and operations (P1/P2)

| Step | Change                                                                | Notes                                                    |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| 3.1  | Object storage (S3/MinIO) for uploads; DB keeps metadata; signed URLs | Closes GAP-07 / S-1. Required before horizontal scaling. |
| 3.2  | Playwright + 6 critical journeys                                      | Precondition for any frontend migration                  |
| 3.3  | Enable CSP in production                                              | Closes S-2                                               |
| 3.4  | Attach zod-derived schemas to routes for real OpenAPI                 | Closes API-1                                             |
| 3.5  | Documented restore drill                                              | Closes GAP-11                                            |

## Phase 4 — Enterprise depth (P2)

| Step | Change                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | Nx module-boundary tags + lint rule                                                                                        |
| 4.2  | Query plans for the 10 slowest endpoints; index from evidence                                                              |
| 4.3  | Verify GAP-15 (immutable schedule versions) and GAP-18 (rule versioning + effective dating); implement if genuinely absent |
| 4.4  | Consolidated customer exposure (GAP-29) if not already derivable                                                           |
| 4.5  | Next.js pilot on `apps/marketing` only                                                                                     |

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
