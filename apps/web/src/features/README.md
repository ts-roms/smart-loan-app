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

| Concern | Where |
| --- | --- |
| Routed page | `features/<name>/pages/` |
| Component used by 2+ pages **in the same feature** | `features/<name>/components/` |
| Component used by **2+ features** (e.g. global Avatar, generic Modal) | `libs/ui/` |
| Data-fetching hook (TanStack Query) | `libs/api-client/` — re-exported by `features/<name>/hooks.ts` |
| Transport types (shared with API) | `libs/shared-types/` |
| UI-only types (form state, local enums) | `features/<name>/types.ts` |
| Format helpers (formatMoney, etc.) | `libs/shared-utils/` |
| Display labels, role copy, etc. | `features/<name>/constants.ts` |

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
import { LoanListPage, LoanDetailPage } from '@/features/loans';

// bad — reaches into internals
import { NewLoanDialog } from '@/features/loans/components/NewLoanDialog';
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

`features/loans/` is the worked example — copy its shape when migrating
the next module.

## Migration backlog

In rough order of "which one looks the most like loans, do it next":

- [x] **loans** — list + detail + new-application dialog
- [ ] **customers** — list + detail (+ KYC sub-view)
- [ ] **kyc** — review queue
- [ ] **scoring** — credit survey page
- [ ] **loan-products**
- [ ] **collections** — list + per-loan panel (the panel itself moves into
      `features/loans/components/` since it's loan-scoped)
- [ ] **payments** — bulk-payment importer
- [ ] **accounting** — already has its own subfolder; promote to feature
- [ ] **rbac** — users + roles + delegations (group as `features/access/`?)
- [ ] **decisioning** — decision-rules
- [ ] **screening** — AML watchlist
- [ ] **notifications**
- [ ] **jobs**
- [ ] **portal** — customer-facing
