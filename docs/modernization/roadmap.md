# Modernization Roadmap

Derived from the Phase 0 audit. Sequenced by risk, not by visibility.

**Governing principle** (the brief's §87, which I endorse): stability and
financial correctness over architectural purity. The repository is in better
shape than the brief assumes — no listed feature is missing, money typing is
already correct, layering already matches the target. The work that remains is
about _guarantees_, and it is smaller and more valuable than a framework
migration.

---

## Phase 1 — Financial guarantees (P0)

Nothing else should start before this phase ships. Each item is small; together
they eliminate three classes of silent money error.

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

## Phase 2 — Proof (P1)

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

Phase 1.1 — the duplicate-journal detection query. It is read-only, it is a
handful of lines, and its result determines whether 1.2 can ship as a
straightforward constraint or needs a reconciliation step first.

I have **not** started it: the brief says audit first, and this document is the
audit. Say the word and Phase 1 begins.
