# Next.js Migration Assessment

## Position

**Recommended: defer.** Not "never" — defer until the P0 financial guarantees in
`financial-engine-audit.md` are closed.

The reasoning is the brief's own principle (§87): _stability and financial
correctness are more important than architectural purity._ Migrating 68 routes
and 148 components changes no financial behaviour and delivers no user-visible
capability, while the three P0 defects can each cost real money and each fix is
measured in hours. Sequencing the framework migration ahead of them would be
choosing the visible work over the important work.

## What migration would actually cost

| Factor                             | Assessment                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Shared libraries already extracted | **Favourable** — `libs/ui`, `api-client`, `shared-types`, `shared-utils` exist. The brief's step one is done. |
| Routes to migrate                  | 68 in `apps/web`, plus `apps/platform` and `apps/marketing`                                                   |
| Components                         | 148 `.tsx`                                                                                                    |
| Regression safety net              | **Poor** — 1 frontend test, no E2E. This is the blocker.                                                      |
| Data-fetching model                | TanStack Query throughout; Server Components imply rethinking each fetch                                      |
| PWA                                | must be preserved; changes shape under App Router                                                             |
| Auth                               | token-based via `ApiClient` singleton with refresh; SSR needs a cookie/session story                          |

**The decisive factor is the regression safety net.** Migrating a frontend with
one test file and no E2E suite means the only verification is manual clicking.
For screens that display balances and initiate disbursements, that is not
adequate. GAP-43 (Playwright + 6 critical journeys) is a **precondition**, not a
parallel workstream.

## What should migrate, and in what order — when the time comes

Migrate for a _reason_, not for the label. The reasons that would apply here:

- **`apps/marketing`** — a public site is where SSR/SSG genuinely pays (SEO,
  first paint). It is also the lowest-risk app in the repo: no financial data, no
  auth. **Migrate first, as the pilot.** It proves the toolchain, the shared-lib
  consumption and the deploy path at near-zero risk.
- **`apps/web`** — migrate only after Playwright coverage exists, and then
  page-group by page-group behind the existing URL structure. Order: auth →
  dashboard → customer 360 → applications → loans → payments → collections →
  reports → administration.
- **`apps/platform`** — last. Small audience, highest privilege.

## What should NOT be rewritten

- `libs/ui`, `libs/api-client`, `libs/shared-types`, `libs/shared-utils` — these
  are framework-agnostic and are the reason a migration is feasible at all.
- The permission-gating idiom (`usePermission` / `useMyPermissions`) — it mirrors
  server keys and works identically under any React renderer.
- The TanStack Query key conventions — portable, and re-deriving them as Server
  Component fetches would lose the cache-invalidation discipline that currently
  keeps mutations coherent.
- Anything financial. Balance and schedule computation belong in `libs/loans` and
  the API, not in a component, and no rendering change should touch them.

## Migration tracker (to be filled when work starts)

| Page                              | Old route | New route | Status | API deps | Components | Tests | Issues |
| --------------------------------- | --------- | --------- | ------ | -------- | ---------- | ----- | ------ |
| _(empty — migration not started)_ |           |           |        |          |            |       |        |

## Recommendation summary

1. Close P0-1, P0-2, P0-3.
2. Add invariant tests and the golden corpus.
3. Add Playwright with the six critical journeys.
4. Pilot Next.js on `apps/marketing`.
5. Re-evaluate. If the pilot shows no concrete benefit for the authenticated LMS
   surface, **it is legitimate to stop there** — three working Vite SPAs sharing
   a design system is not a defect requiring correction.
