# Frontend Audit

**36** feature folders, **148** `.tsx` files, **68** lazy-loaded routes in
`apps/web/src/App.tsx`. Plus `apps/platform` and `apps/marketing`, both Vite SPAs.

## Stack

React 18.3, Vite 6.4, react-router-dom 7.18, TanStack Query 5.101, Tailwind 3.4,
zod (shared with the API), `vite-plugin-pwa` 0.21.

**There is no Next.js anywhere in the repository.** The brief's target frontend
is therefore a genuine migration, not an upgrade — see `nextjs-migration.md`.

## Strengths

- **The shared libraries the migration would need already exist**: `libs/ui`,
  `libs/api-client`, `libs/shared-types`, `libs/shared-utils`. The brief names
  extracting these as migration step one (§39); it is already done, which
  materially lowers the cost of any frontend change.
- **Permission-aware UI**: controls are gated on the same permission key the
  endpoint enforces, so the screen does not promise actions the API will refuse.
- **Consistent data layer**: TanStack Query throughout with per-feature query-key
  conventions, so cache invalidation after a mutation is predictable.

## Weaknesses

**F-1 (P1) — the frontend is effectively untested.** Of 47 test files, **one** is
in `apps/web`. No component-test or E2E framework is configured; Playwright is
not a dependency, and `docs/smoke-tests/e2e.sh` is a shell script, not a browser
suite. For a system where a mis-rendered balance is a customer-facing financial
error, this is the largest testing gap in the repository.

**F-2 (P2) — 28 `react-refresh/only-export-components` lint warnings.** Files
that export both components and non-components. Harmless at runtime, degrades
hot-module reload, and represents accepted-but-unaddressed debt. (ESLint reports
**0 errors**, so the build is clean.)

**F-3 (P3) — three separate SPAs** mean three build pipelines and three copies of
shared code in the output. Defensible — different audiences, different deploy
cadence, and the marketing site should not ship the LMS bundle — but worth
recording as a deliberate choice rather than drift.

## PWA

`vite-plugin-pwa` is configured and installable/offline behaviour is a real
requirement for field collectors. Any migration must preserve it; this is a
constraint on the target framework, not an afterthought.
