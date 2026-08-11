# Testing

Living reference. Coverage findings: `test-coverage-audit.md`.

---

## Inventory

Roughly **90 test files** across 14 Nx test targets. Runner: vitest 4.1.

| Project                                                                                   | Focus                                                                                          |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `libs/accounting`                                                                         | entry builders, posting, **18 invariants**                                                     |
| `libs/loans`                                                                              | amortization, renewal, schedule balance, **8 position invariants**, **49 golden assertions**   |
| `libs/db`                                                                                 | payments, allocation repair, tenancy, **idempotency (12)**, **decide (15)**, **job slots (4)** |
| `apps/api`                                                                                | RBAC, tenant isolation, authorization integration, compliance, retention, portal, delegations  |
| `libs/shared-utils`                                                                       | presence (89 assertions), formatting, dates                                                    |
| `libs/kyc`, `credit-scoring`, `auth`, `screening`, `payments`, `licensing`, `decisioning` | domain units                                                                                   |
| **`apps/web`**                                                                            | **1 file for 148 components** ← the gap                                                        |

## Three kinds of test, and what each is for

**Unit / example.** "This input gives this output." The bulk of the suite.

**Invariants (§61).** "This must hold for _every_ input." Property-shaped, with
a **seeded** generator so a failure is reproducible from the test name — a
financial test that fails and cannot be re-run is worse than no test. These keep
holding when someone changes a rate, a fee rule or an account code:

- journal debits == credits, for every builder across the amount range
- allocation conserves the payment exactly: interest + principal + overpayment == amount
- interest is recognised once across repeated partial payments
- a reversal nets every account to zero
- neither ledger position ever goes negative
- a repeated idempotency key creates nothing
- a due job runs exactly once per slot
- a loan is decided once, and only while it is still a pending decision

**Golden corpus (§82).** Two files, 76 assertions:

- `golden-corpus.test.ts` — principal, rate, term, frequency across 8 scenarios
- `golden-corpus-lifecycle.test.ts` — fees, penalties, grace, payment history,
  payoff, renewal proceeds

Fixed scenarios with committed expected values, in two halves with **different
authority** — and both files say so in their headers:

| Half             | Authority                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VERIFIED         | closed-form, independent of the implementation (first-period interest, flat interest, the annuity formula, principal summing exactly). **If the code disagrees, the code is wrong.** |
| CHARACTERIZATION | fingerprints captured from the implementation. Proves behaviour has not **changed**; does not prove it is **right**.                                                                 |

## The rule for financial changes

1. The golden corpus must pass **unchanged**.
2. Its VERIFIED half must pass **without amendment**.
3. A characterization value may be updated only with a written reason in the
   commit, and only after 2 holds.

Until the corpus is replaced with worked examples from signed loan documents it
can detect _drift_ but not _pre-existing error_. That substitution is the single
change that would make it authoritative rather than merely protective.

## Gaps

| Gap                                                                                            | Priority                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| Frontend effectively untested — 1 file, 148 components                                         | **P1**                                 |
| No E2E framework (`docs/smoke-tests/e2e.sh` is a shell script; Playwright is not a dependency) | **P1** — blocks any frontend migration |
| Golden corpus lacks fees, penalties, grace period, payment history, restructure, payoff (§82)  | P1                                     |
| No coverage reporting — the numbers above are files, not lines                                 | P3                                     |

## CI

```
nx run-many -t typecheck    22 projects
nx run-many -t test         14 targets
nx run-many -t build         4 projects
eslint .                     0 errors (28 accepted react-refresh warnings)
prisma format                via libs/db
```

All five must be green before a commit lands. `build` was added to this list
after a self-audit found §77 lists it and it had been skipped.

## Probing live data

Several defects here can only be proven against a real database. The standing
rule, learned the hard way: **restore everything the operation touched.**
`recordPayment` mutates schedule allocations, closes loans and posts journal
entries; a probe that only deletes the payment row leaves the schedule wrong.
Prefer a throwaway entity; where that is impractical, capture the prior state
first and verify the trial balance after.
