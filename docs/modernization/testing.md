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

| Gap                                                                                                                                  | Priority                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Frontend component testing — harness plus 5 files, 45 tests. Covers the surfaces where being wrong is costly, not the 148 components | **PARTIAL** (was P1)                                                  |
| E2E — Playwright, 6 journeys, 21 assertions against a live stack. Read-only; no journey covers apply → disburse → pay                | **PARTIAL** (was P1) — a disposable database per run is the next step |
| Golden corpus lacks fees, penalties, grace period, payment history, restructure, payoff (§82)                                        | P1                                                                    |
| No coverage reporting — the numbers above are files, not lines                                                                       | P3                                                                    |

## Frontend

The harness is jsdom + Testing Library, wired in `apps/web/vitest.config.ts`:

- `src/test/setup.ts` — stubs only what jsdom genuinely lacks (ResizeObserver,
  pointer capture, matchMedia), and **fails any test that reaches `fetch`**. A
  component test that quietly falls through to the network is testing the
  absence of a response, and it passes for the wrong reason.
- `src/test/render.tsx` — `renderWithProviders` mirrors `main.tsx` minus theme,
  auth and PWA. Tests mock `@loan/api-client` at the module boundary, so they
  depend on what a hook RETURNS rather than on how a request is built — the seam
  that survives a transport change.

What is covered is chosen by consequence, not by coverage percentage. The four
suites are the places where a wrong render costs something:

| Suite                   | The risk it holds down                                            |
| ----------------------- | ----------------------------------------------------------------- |
| `CustomerDetail.guards` | Edit / Apply offered on an erased or archived customer            |
| `Users.actions`         | "Sign out everywhere" contradicting the Presence column beside it |
| `DecisionRules.history` | A rule's version and its superseded text staying readable         |
| `use-permission`        | The gate behind every hidden control failing OPEN                 |

Writing them found two real accessibility defects, both now fixed: the version
badge announced only "v3" to a screen reader, and the rule editor's labels were
not associated with their controls. Nine other copies of that `Field` helper
carry the same defect — see the spawned task.

## E2E

Playwright, in `apps/web/e2e/`, run with `pnpm --filter @loan/web e2e`. Six
journeys against a **live** API: auth, RBAC, the customer list and detail, the
decision-rule version history, and the loan schedule's arithmetic. Full
prerequisites in `apps/web/e2e/README.md`; `00-stack.spec.ts` checks them first
and names the missing one.

They exist for exactly one reason the component suites cannot serve. Those mock
`@loan/api-client`, so a field renamed on the server passes every one of them
and blanks a column in production. Only a live round trip catches it.

Two things the suite learned about itself while being written, both worth
keeping:

- **The login route is throttled at 10/minute**, and signing in per test tripped
  it on the twelfth. The repair belonged in the suite, not the app — sessions
  are now saved once per role by a setup project and reused. Raising the limit
  would have weakened a real control to suit a habit no user has.
- **`e2e/` was invisible to `tsc` and ESLint** until added to
  `apps/web/tsconfig.json`. A test suite nothing checks rots quietly.

**Still missing: a write journey.** Every journey reads. This is a development
database with hand-built fixtures and a nightly reconciliation; a suite that
created loans would drift it on every run and the drift would surface as a
finding somebody has to investigate. The cost is that nothing covers apply →
approve → disburse → pay, which is the flow most worth covering. Doing it
properly needs a disposable database per run — not cleanup code that fails
halfway and leaves the ledger worse than no test at all.

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
