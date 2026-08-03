# Feature-based architecture

Each module under this folder is a **self-contained vertical slice** of the
web app. A feature owns its pages, the UI components those pages use, the
data-access hooks they consume, feature-local types, and any constants /
copy strings. Cross-feature imports go through the feature's `index.ts`
public API — never into a feature's internal files.

This convention lets us:

- find everything related to a feature in one place (no jumping between
  `pages/`, `components/`, `hooks/`, `lib/`),
- delete a feature by deleting its folder,
- treat each feature's `index.ts` as a stable contract — internal
  refactors don't ripple outward.

## Layout

```
features/<name>/
├── pages/                         # routed page components (1 per route)
│   ├── XxxListPage.tsx
│   └── XxxDetailPage.tsx
├── components/                    # UI used by THIS feature's pages
│   ├── XxxStatusBadge.tsx
│   ├── XxxDialog.tsx              # large flows worth their own file
│   └── ...
├── hooks.ts                       # data-access hooks (usually re-exports
│                                  # from @loan/api-client, sometimes wraps
│                                  # them with feature-specific derivations)
├── constants.ts                   # labels, enums-to-display maps, copy
├── types.ts                       # types that don't belong in @loan/shared-types
│                                  # because they're UI-only (form state,
│                                  # local discriminated unions, etc.)
└── index.ts                       # public API — pages + reusable components
                                   # only. Internal helpers stay private.
```

Not every feature needs every file — start with `pages/` + `index.ts` and
add `components/`, `constants.ts`, etc. only when there's something to put
in them.

## What lives WHERE

| Concern                                                               | Where                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| Routed page                                                           | `features/<name>/pages/`                                       |
| Component used by 2+ pages **in the same feature**                    | `features/<name>/components/`                                  |
| Component used by **2+ features** (e.g. global Avatar, generic Modal) | `libs/ui/`                                                     |
| Data-fetching hook (TanStack Query)                                   | `libs/api-client/` — re-exported by `features/<name>/hooks.ts` |
| Transport types (shared with API)                                     | `libs/shared-types/`                                           |
| UI-only types (form state, local enums)                               | `features/<name>/types.ts`                                     |
| Format helpers (formatMoney, etc.)                                    | `libs/shared-utils/`                                           |
| Display labels, role copy, etc.                                       | `features/<name>/constants.ts`                                 |

## Public API rules

The feature's `index.ts` should export:

- ✅ **Routed pages** — App.tsx imports these
- ✅ **Components that other features legitimately need** — e.g. a
  `LoanStatusBadge` that a dashboard summary might render
- ❌ **Internal helpers, dialogs, form state types** — keep these
  private to discourage cross-feature coupling

A consumer should be able to write
`import { LoanListPage, LoanStatusBadge } from '@/features/loans'`
and nothing more from inside the loans folder.

## Importing

`apps/web/tsconfig.json` and `vite.config.ts` define an `@/*` path alias
that maps to `apps/web/src/`. Use it for feature imports:

```ts
// good
import { LoanListPage, LoanDetailPage } from "@/features/loans";

// bad — reaches into internals
import { NewLoanDialog } from "@/features/loans/components/NewLoanDialog";
```

## Migrating an existing module

1. `mkdir -p features/<name>/{pages,components}`
2. Move the routed component(s) from `pages/Xxx.tsx` →
   `features/<name>/pages/XxxPage.tsx`. Rename so the suffix is `Page`.
3. Extract pieces that are shared between pages or worth isolating into
   `features/<name>/components/`. Don't over-extract — internal helpers
   that fit on one screen are fine inline.
4. Pull display labels into `constants.ts` and form-state types into
   `types.ts`.
5. Create `hooks.ts` that re-exports the relevant hooks from
   `@loan/api-client`. This makes the feature's data surface explicit
   and lets us inject derivations later without leaking them.
6. Write `index.ts` — export only the public API (pages + reusable
   components).
7. Update `apps/web/src/App.tsx` to import from `@/features/<name>`.
8. Delete the old `pages/Xxx.tsx`.

## Reference implementation

`features/loans/` is the worked example — copy its shape when adding a
new feature. `features/lease/` is a slimmer real-world example of the
same pattern (queue page + shared display constants + hooks re-export).

## Current state

All 29 vertical slices live in their own folder and route from
`App.tsx`. Internal completeness varies — `pages/` + `index.ts` is
universal; `components/`, `hooks.ts`, `constants.ts`, `types.ts`
appear where the feature actually has something to put in them
(the README's explicit guidance — don't add empty files for symmetry).

| Feature                                                              | pages | components | hooks | constants | notes                                                   |
| -------------------------------------------------------------------- | :---: | :--------: | :---: | :-------: | ------------------------------------------------------- |
| **loans**                                                            |   ✓   |     ✓      |   ✓   |     ✓     | reference implementation                                |
| **lease**                                                            |   ✓   |     —      |   ✓   |     ✓     | Queue + per-loan panel in `loans/components`            |
| **customers**                                                        |   ✓   |     ✓      |   —   |     ✓     | rich profile + ledger                                   |
| **portal**                                                           |   ✓   |     —      |   —   |     —     | borrower-facing; reuses `LOAN_TYPE_LABELS` from `loans` |
| **accounting**                                                       |   ✓   |     ✓      |   —   |     —     | 9 routed pages (dashboard, COA, journal, periods, etc.) |
| **collections**                                                      |   ✓   |     ✓      |   —   |     —     | overdue queue + demand letters                          |
| **cooperative**                                                      |   ✓   |     ✓      |   —   |     —     | 7-entity coop ledger UI                                 |
| **delegations**                                                      |   ✓   |     ✓      |   —   |     —     | inline constants — single-page feature                  |
| **dorsi**                                                            |   ✓   |     —      |   —   |     —     | Inline label map                                        |
| **repossession**                                                     |   ✓   |     —      |   —   |     —     | Inline label map                                        |
| **kyc**                                                              |   ✓   |     ✓      |   —   |     —     | reviewer queue                                          |
| **loan-products**                                                    |   ✓   |     ✓      |   —   |     —     | product editor                                          |
| **reconciliation**                                                   |   ✓   |     ✓      |   —   |     —     | bank statement triage                                   |
| **notifications**                                                    |   ✓   |     ✓      |   —   |     —     | bell list + mark-read                                   |
| **profile**                                                          |   ✓   |     ✓      |   —   |     —     | signature pad + idle policy                             |
| **audit**                                                            |   —   |     ✓      |   —   |     —     | drawer-only (no routed page)                            |
| **assistant**                                                        |   —   |     —      |   —   |     —     | embedded panel; no routed page                          |
| **messaging**                                                        |   —   |     ✓      |   —   |     —     | embedded panel on loan detail                           |
| **help**                                                             |   ✓   |     ✓      |   —   |     —     | + `content.ts` (per-module FAQ)                         |
| **dashboard**                                                        |   ✓   |     —      |   —   |     —     | KPIs + charts only                                      |
| **compliance**                                                       |   ✓   |     —      |   —   |     —     | Annual-docs cross-loan view                             |
| **auth, decisioning, ecl, jobs, payments, rbac, reports, screening** |   ✓   |     —      |   —   |     —     | minimal single-page features                            |

The table isn't a checklist — it's a record of what's earned its
place. If you find yourself duplicating a label across pages in the
same feature, extract it. If two features reference the same map
(e.g. product code → display name), the second consumer imports from
the first feature's public API (see `portal/pages/Portal*.tsx`
importing `LOAN_TYPE_LABELS` from `features/loans`).
