# Test Coverage Audit

**47 test files** — excluding the stale `.claude/worktrees` copies, which inflate
a naive `find` to 83. Runner: vitest 4.1.10, 14 test targets under Nx. Full suite
currently green (22 typecheck projects, 14 test targets, ESLint 0 errors).

## Distribution

| Project                                                                    | Files  | Covers                                                                                                                                          |
| -------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                                                                 | 15     | RBAC, tenancy isolation, authorization integration, compliance, retention, portal, delegations, demand letters, notification providers, uploads |
| `libs/db`                                                                  | 8      | payments, allocation repair, tenant cache, multi-tenant migrate, DORSI helpers, adopt-existing                                                  |
| `libs/loans`                                                               | 6      | amortization — the deepest-covered domain                                                                                                       |
| `libs/shared-utils`                                                        | 4      | includes 89 assertions in presence alone                                                                                                        |
| `libs/kyc` / `credit-scoring` / `auth` / `accounting`                      | 2 each | validation, scoring, sign, posting                                                                                                              |
| `libs/screening` / `payments` / `licensing` / `decisioning` / `api-client` | 1 each |                                                                                                                                                 |
| **`apps/web`**                                                             | **1**  | ← the gap                                                                                                                                       |

## Assessment

**What is right:** the _financial_ libraries carry the deepest coverage, which is
the correct instinct. `tenant-isolation.test.ts` and
`authorization.integration.test.ts` guard the two properties whose failure would
be both catastrophic and silent.

## Gaps

**T-1 (P1) — no property/invariant tests.** The brief §61 asks for exactly the
tests that would have caught every P0 in `financial-engine-audit.md`:

- journal debits == credits, per entry and per period
- sum of allocations <= payment amount
- outstanding principal == disbursed − principal paid ± approved adjustments
- a reversal offsets its original exactly
- **a repeated idempotency key creates no second transaction**
- balance never negative unless explicitly supported

None exist today. Highest value per hour of any work in this audit.

**T-2 (P1) — no golden financial corpus.** No fixed worked examples per product
(salary / housing / auto / motorcycle) with committed expected schedules covering
fees, penalties, grace, partial payment, advance payment, restructure and payoff.
Until this exists, **no calculation may be refactored** — the brief §81 says so
and the reasoning is sound: existing arithmetic may be legally and accountingly
significant, and "it looks cleaner" is not a reason to risk it.

**T-3 (P1) — frontend untested.** One test file for 148 components.

**T-4 (P2) — no E2E framework.** `docs/smoke-tests/e2e.sh` plus `fixtures.ts`
give a scripted happy path (genuinely useful for seeding), but not a browser-level
regression suite. Playwright is not a dependency.

**T-5 (P3) — no coverage reporting.** The table above counts _files_, not lines.
Real coverage is unknown and is likely lower than the distribution suggests.

## Recommended order

1. **Invariant tests (T-1)** — cheapest, and they encode the P0 fixes as
   permanent guarantees rather than one-time patches.
2. **Golden corpus (T-2)** — unblocks all future calculation work.
3. **Playwright + 6 critical journeys (T-4)**: login, apply, approve, disburse,
   record payment, view statement.
4. **Component tests for money-rendering surfaces (T-3)**.
5. **Coverage reporting (T-5)** last — measure after the meaningful tests exist,
   or the number just rewards writing easy tests.
