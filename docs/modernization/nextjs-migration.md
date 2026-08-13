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

## Migration tracker — `apps/marketing` → `apps/marketing-next` (§72)

Step 4 of the recommendation below is **done**. Every route in
`apps/marketing` has been rebuilt on the App Router in
`apps/marketing-next`, side by side with the original. Findings follow
the table.

| Page           | Old route                      | New route                                         | Status | API dependencies                                | Components                                                                                         | Tests                                           | Issues                                                                                                                |
| -------------- | ------------------------------ | ------------------------------------------------- | ------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Home           | `/`                            | `/` — `app/page.tsx`                              | Done   | none                                            | all server: `Hero`, `Differentiators`, `FeatureSnapshot`, `DeploymentModels`, `FinalCTA`           | none                                            | none — 182 B route JS, all content prerendered                                                                        |
| Pricing        | `/pricing`                     | `/pricing` — `app/pricing/page.tsx`               | Done   | none (reads `@loan/licensing/browser` at build) | all server: `PlanCard`, `FeatureMatrix`, `FeatureGroupRows`, `Check`, `CallSalesBanner`            | none                                            | feature table now scrolls in its own box; the Vite version made the whole page scroll sideways on mobile              |
| Install        | `/install`                     | `/install` — `app/install/page.tsx`               | Done   | none                                            | server: `DockerPath`, `BareMetalPath`, `Step`, `Code`, `RequirementsCard` · client: `PathSwitcher` | none                                            | both guides are server-rendered and passed into the client tab strip as props — the guide text ships no JS            |
| Contact        | `/contact`                     | `/contact` — `app/contact/page.tsx`               | Done   | `POST /public/leads`                            | server: page shell · client: `LeadForm`, `Field`, `DeploymentChoice`                               | none                                            | success state no longer replaces the `<h1>`; Server Action rejected on purpose (see "What was deliberately not done") |
| Signup         | `/signup`                      | `/signup` — `app/signup/page.tsx`                 | Done   | `POST /public/signup`                           | client: `SignupForm`, `CheckYourEmail`, `Field`                                                    | `src/lib/site.test.ts` — 6 cases over `slugify` | whole page is client: the "check your email" state replaces the heading, so splitting it would change what is shown   |
| Signup confirm | `/signup/confirm`              | `/signup/confirm` — `app/signup/confirm/page.tsx` | Done   | `POST /public/signup/confirm`                   | server: `<Suspense>` shell · client: `ConfirmPanel`, `Credentials`, `Row`                          | none                                            | `useSearchParams()` fails `next build` without the `<Suspense>` — passes `next dev`. See below.                       |
| Not found      | `<Route path="*">`             | any unmatched — `app/not-found.tsx`               | Done   | none                                            | server                                                                                             | none                                            | now returns a real HTTP 404; the SPA returned 200 with 404 markup                                                     |
| Health probe   | nginx `location = /health.txt` | `/health.txt` — `app/health.txt/route.ts`         | Done   | none                                            | route handler, `force-static`                                                                      | none                                            | moves from nginx config into the Node process — see the deploy section                                                |

**Every URL is preserved. Nothing moved, nothing was renamed, nothing
gained or lost a trailing segment.**

## What the pilot found

### 1. `libs/ui` cannot be imported from a Server Component — the barrel is the problem

This is the headline, and it was measured rather than reasoned about.

`import { Button } from "@loan/ui"` in a Server Component **fails
`next build`**:

```
../../libs/ui/src/components/confirm.tsx
  x You're importing a component that needs createContext. It only works
    in a Client Component but none of its parents are marked with
    "use client", so they're Server Components by default.

Import trace for requested module:
  ../../libs/ui/src/components/confirm.tsx
  ../../libs/ui/src/index.ts
  ./src/app/uiprobe/page.tsx
```

Five modules poison the barrel — `confirm.tsx`, `datepicker.tsx`,
`file-dropzone.tsx`, `idle-logout.tsx`, `password-input.tsx` — because
each calls `createContext` / `useState` / `useRef` at module scope with
no `"use client"` directive. There are **zero** `"use client"`
directives anywhere in `libs/ui` today. `libs/ui/src/index.ts` re-exports
all 29 components from one file, so importing `Button` drags all five in.

**But the components themselves are mostly fine.** Deep-importing past
the barrel works:

```tsx
import { Button } from "@loan/ui/src/components/button";
```

That compiles, prerenders, and emits **142 B of route JS — zero client
JavaScript**. `forwardRef`, `cva` and Radix's `Slot` are all RSC-safe.
Radix's interactive packages ship their own `"use client"`, so
`dialog.tsx`, `select.tsx` and friends are boundaries already.

So the fix is small and the diagnosis is precise:

- **Not** "libs/ui is incompatible with Next".
- **Is** "libs/ui's five stateful modules need `"use client"`, and its
  single-file barrel needs to stop making every consumer pay for them."

Adding the directive was NOT done here. Rollup warns
`Module level directives cause errors when bundled, "use client" was
ignored` — so the change lands as build noise in `apps/web`,
`apps/platform` and `apps/marketing` to benefit an app that does not
exist yet. It belongs in the `apps/web` migration, as its first commit.

### 2. The token mismatch is the _other_ reason, and it is the bigger one

Even deep-imported and rendering server-side, the button came out
**completely unstyled**. Its markup is
`class="… bg-primary text-primary-foreground ring-offset-surface-2 …"`,
and those tokens are declared in `libs/ui/src/globals.css` and mapped in
`apps/web/tailwind.config.ts`. The marketing site has its own deliberate
palette (`--accent-strong`, `--bg-elev`, `--text-dim`) that predates and
does not overlap the console's.

Consuming `@loan/ui` therefore means adopting the console's entire
design-token system, not adding a dependency. For `apps/web` that is
free — it already owns those tokens. For marketing it would be a
redesign, so it was not done, and `@loan/ui` is not a dependency of
`apps/marketing-next`. Note that the Vite marketing app never depended
on `libs/ui` either; the pilot probed it deliberately rather than
inheriting a dependency.

### 3. What the workspace needed, exactly

Every one of these is a cost `apps/web` will also pay.

| Change                                         | Why                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transpilePackages: ["@loan/licensing", …]`    | Every `libs/*` sets `main: src/index.ts` with no build step. Vite compiles workspace links as source; Next treats anything resolved from node_modules as compiled JS and hands the `.ts` to no loader. Hand-maintained list. `apps/web` would need 8+ entries plus transitives. |
| `experimental.outputFileTracingRoot`           | Points the standalone tracer at the repo root so it follows pnpm's symlinks out of the app dir. **Top-level in Next 15, under `experimental` in Next 14** — put it in the wrong place and you get an "Unrecognized key(s)" warning and a silently broken standalone bundle.     |
| `baseUrl: "."` restated in `tsconfig.json`     | `tsconfig.base.json` sets `baseUrl` relative to itself, and `paths` is replaced wholesale rather than merged. Without the restatement `@/*` resolves to `<repo-root>/src/*`.                                                                                                    |
| `jsx: "preserve"`, `moduleResolution: bundler` | Next's requirements. The base config's `react-jsx` makes `next build` rewrite the tsconfig on every run.                                                                                                                                                                        |
| `postcss.config.mjs`, not `.js`                | The package has no `"type": "module"`, so a `.js` config is parsed as CommonJS and `export default` is a syntax error.                                                                                                                                                          |
| **Next 14, not Next 15**                       | Next 15's App Router requires React 19. The workspace is pinned to React 18.3.1 and `libs/ui` peers on `^18.3.1`. Migrating `apps/web` to Next 15 means a React 19 upgrade for every front-end at the same time — two migrations, not one.                                      |
| `VITE_*` → `NEXT_PUBLIC_*`                     | Both are build-time inlining, different prefix. Reaches outside the app: `deploy/railway/Dockerfile.marketing` passes the old names as build args.                                                                                                                              |

**Windows path length.** `next`'s deepest files sit at 281 characters
inside a pnpm virtual store in an agent worktree, past Windows' 260-char
`MAX_PATH`. The package directory is created but left empty, so
resolution succeeds and the build dies later on
`Cannot find module .../jest-worker/processChild.js`. At the repo's
normal checkout path it measures 234 and does not bite. The one-line
remedy is `virtual-store-dir-max-length=50` in `.npmrc`; it is recorded
here rather than committed, because it forces a full re-link for
everyone to fix a problem only deep checkouts have.

### 4. Things that were easier than expected

- **All 8 routes are statically prerendered** (`○` in the build output).
  Nothing forced dynamic rendering.
- **`@loan/licensing/browser` and `@loan/shared-types` work in Server
  Components unmodified.** RSC compatibility is not about what a library
  is, it is about whether its module graph touches React state. Both are
  inert data and types.
- **Per-route metadata**, which the Vite app structurally could not have:
  one `index.html` meant one `<title>` and one description for all six
  routes. On a public marketing site this is the clearest single argument
  for the migration.
- **`app/not-found.tsx` returns a real 404**, where the SPA returned 200.

### 5. Things that were harder, and generalise badly

- **`useSearchParams()` fails `next build` unless wrapped in
  `<Suspense>`** — and passes `next dev`, so the failure arrives at the
  end of the loop. `apps/web` reads query strings on every filtered list
  and paginated table; it will hit this on nearly every screen. The
  escape hatch (reading `searchParams` from the page's props) silently
  opts the route into per-request rendering, so choosing it by reflex
  turns a static app into a server-rendered one page by page.
- **The route-aware chrome must be a Client Component.** `usePathname()`
  and `useSelectedLayoutSegment()` are client-only by design. Here that
  cost one small file. In `apps/web` the sidebar reads permissions,
  licence features and tenant context — the part of the app with the
  most imports is the part that cannot stay on the server.
- **Module co-location now decides what ships.** `Credentials` had to be
  split into its own file, or `"use client"` on the signup form would
  have dragged the whole form into `/signup/confirm`'s bundle. Under
  Vite, file layout affected nothing but readability.
- **Code silently relocates.** The footer's `new Date().getFullYear()`
  now evaluates at build time, not per visitor. The signup form's
  `toLocaleString()` for the token expiry stayed client-side by luck of
  being in a form. Nothing marks which of the two a moved line was.

### What was deliberately not done

- **No Server Actions.** `POST /public/leads` is rate-limited by IP; a
  Server Action would make every submission arrive from the marketing
  server's single IP and throttle the site as a whole. That is an
  `apps/api` change, and it is out of scope. The point generalises: an
  RSC migration relocates the _client_ of every API call it converts,
  which matters wherever the API decides anything from the caller's
  identity — rate limits, audit-log IP, geo.
- **No component tests.** Rendering an App Router page under vitest needs
  jsdom, testing-library and a server/client environment shim, none of
  which this pilot set up. The only tests are 6 cases over `slugify`.
  The regression net for this migration was **manual browser
  verification**, which is exactly what `financial-engine-audit.md` says
  is not adequate for `apps/web`.

## Verification performed

`next build` output: **all 8 routes prerendered static** (`○`), 87.3 kB
shared first-load JS. Then `next start`, and every route loaded in a
browser:

| Checked                                       | Result                                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                           | renders; `body` background `rgb(246,247,249)`, text `rgb(23,28,38)`, `h1` 52px/700, primary button `rgb(10,95,158)` on white — identical to the Vite tokens                 |
| `/pricing`                                    | 32 table rows, 45 ✓ / 30 —, tiers read live from `@loan/licensing`: 5 / 15 / 25 features, 10 / 50 / Unlimited seats                                                         |
| `/install`                                    | clicking "Bare-metal" swaps `aria-pressed`, shows the systemd guide, hides the Docker steps, keeps the shared footer — server-rendered content crossing into a client shell |
| `/contact`                                    | 5 controlled inputs keep their values across a re-render; the three-way deployment toggle switches `aria-pressed` and its accent border/tint                                |
| `/signup`                                     | typing "Bayanihan Multi-Purpose Cooperative" derives `bayanihan-multi-purpose-cooperative` and the hint resolves `NEXT_PUBLIC_APP_URL` correctly                            |
| `/signup/confirm?token=…` and without a token | both branches render the right panel                                                                                                                                        |
| `/does-not-exist`                             | HTTP **404** (the SPA returned 200), chrome intact                                                                                                                          |
| `/health.txt`                                 | `ok`, HTTP 200                                                                                                                                                              |
| client-side navigation                        | `next/link` navigates without a reload; the active nav item is `--text` and the rest `--text-dim`; `<title>` updates per route                                              |
| response headers                              | CSP present including `frame-ancestors 'none'`, plus `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`                                                         |
| **console + network**                         | **zero console errors on every page**; every asset 200. The only 404 in the log is the deliberate `/does-not-exist` request.                                                |

One measurement artefact worth recording so nobody re-chases it: reading
`getComputedStyle()` on an element with `transition-colors` returns the
value the transition started from when the browser is not compositing
frames (headless / hidden pane), so active-state colours read one render
stale. Disabling transitions confirms the correct values. This is a
property of the harness, not of the app.

## Deployment

`deploy/railway/Dockerfile.marketing-next` and
`railway.marketing-next.json` are added alongside the existing pair; the
Vite image remains the deployed one. The runtime stage changes from
`nginx:alpine` (~45 MB) to `node:20-slim` (~110 MB), and that single fact
is most of the diff — **nginx was doing four jobs for the marketing
service, because marketing owns the root domain and is therefore the
public edge**: static files, the `/public` proxy, the `/api/v1` +
`/uploads` + `/docs` proxies, and the `/app` mount to the web service.

Next can express all four as `rewrites()`, but they then run inside the
Node process. Only `/public` is wired up here. The honest conclusion is
that a Node process should not be the TLS-terminating edge proxy for a
financial API, so a real migration keeps nginx in front and Next behind
it — which means the deployment gets one more moving part, not one
fewer.

**CSP.** `apps/web` bakes its policy into `index.html` as a `<meta>` from
`vite.config.ts` precisely so it survives all four deployment paths. A
Next app has no `index.html` to bake into, so the policy becomes a real
response header — a strict improvement, since a header can carry
`frame-ancestors` and the `<meta>`/nginx split in
`deploy/railway/nginx.spa.conf.template` disappears. The regression is
the other way: `apps/web`'s script-src needs neither `'unsafe-inline'`
nor `'unsafe-eval'` because every inline script is hashed at build time,
whereas Next injects inline bootstrap scripts that cannot be hashed
without nonce middleware. Marketing's own policy is otherwise far
narrower — no WASM, no OCR CDN, no service worker.

## What this pilot does and does not prove

**Proves:** the toolchain works. An Nx + pnpm workspace can host a Next
App Router app; the configuration required is seven specific items,
listed above, and none is exotic. Shared _data_ and _type_ libraries are
consumed unmodified. Every URL is preservable. The deploy path exists.

**Does not prove the `apps/web` migration is easy, and the pilot is not
evidence that it is.** Marketing is 6 routes, 0 authenticated calls, 0
financial data, 0 TanStack Query, 0 PWA, and it was already
static-shaped — the pages were pure presentation over hardcoded arrays,
so "Server Components by default" cost nothing to achieve. `apps/web` is
68 routes over an `ApiClient` singleton with token refresh, and the four
hardest questions are all untouched here:

1. **Auth.** Token-in-memory with refresh has no SSR story. Server
   Components cannot read it; it would have to become a cookie session,
   which is an `apps/api` change.
2. **TanStack Query.** Re-deriving every fetch as a Server Component
   fetch loses the cache-invalidation discipline that currently keeps
   mutations coherent. The alternative — keep Query, make everything a
   Client Component — buys nothing but the router.
3. **The PWA.** Changes shape entirely under the App Router.
4. **The regression net.** Still the blocker `financial-engine-audit.md`
   named. This pilot was verified by clicking six pages, which is fine
   for a brochure and is not fine for a screen that displays a balance.

The pilot moves the recommendation from "defer, unknown cost" to
"defer, and here is the cost". It does not move it off "defer".

## Recommendation summary

1. Close P0-1, P0-2, P0-3.
2. Add invariant tests and the golden corpus.
3. Add Playwright with the six critical journeys.
4. ~~Pilot Next.js on `apps/marketing`.~~ **Done** — see the tracker
   above. `apps/marketing-next` builds, runs, and preserves every URL.
5. Re-evaluate. If the pilot shows no concrete benefit for the authenticated LMS
   surface, **it is legitimate to stop there** — three working Vite SPAs sharing
   a design system is not a defect requiring correction.

**Re-evaluation, now that step 4 is evidence rather than a plan.** The
benefit found is real but is a _public-site_ benefit: per-route metadata,
static prerendering, and a true 404 — none of which the authenticated LMS
surface wants or can use, since it is behind a login and indexed by
nobody. The costs found (the `libs/ui` barrier, the React 19 gate on Next
15, the auth/SSR gap, the TanStack Query question) all land squarely on
`apps/web` and none of them landed on marketing.

So the position stands, with one amendment: **ship `apps/marketing-next`
if the SEO is worth it, and treat that as the end of the migration rather
than the start of one.** Promoting it is a decision about the marketing
site alone and carries none of `apps/web`'s risk. The two remaining
prerequisites for going further are unchanged and neither is closer:
Playwright coverage, and a cookie-session story from `apps/api`.

## Side-by-side, not in place — and why

`apps/marketing` is untouched and still builds. The new app is a
separate Nx project at `apps/marketing-next` (`@loan/marketing-next`,
dev port 5176 so it collides with neither 5173/5174/5175).

Replacing in place would have satisfied §38 only on a technicality —
"recoverable from git" is true of any deletion. Side-by-side was chosen
because the pilot's entire purpose is comparison, and three things are
only possible while both exist:

1. **`nx run-many -t build` builds both**, so a regression in either is
   caught by the same command.
2. **Visual parity is checkable by A/B**, running :5175 and :5176 at
   once. This is how the mobile-scroll bug on `/pricing` was found — in
   the _old_ app.
3. **The deployed Railway service is untouched.** Promoting the pilot is
   a config change (point the service at
   `railway.marketing-next.json`), and rolling back is the same change
   in reverse. Nothing is staked on the pilot being right.

The cost is that `apps/marketing` and `apps/marketing-next` will drift if
both are edited. They should not both be edited: if the pilot is
promoted, `apps/marketing` is deleted in that same commit, and if it is
not, `apps/marketing-next` is.

**One thing was left undone deliberately.** `eslint.config.mjs`'s
browser-globals block lists app paths explicitly:

```js
files: [
  "apps/web/**/*.{ts,tsx}",
  "apps/platform/**/*.{ts,tsx}",
  "apps/marketing/**/*.{ts,tsx}",
  …
```

`apps/marketing/**` does not match `apps/marketing-next/**`, so the new
app currently gets **no `react-hooks` linting**. It is not a lint
failure — `no-undef` is already disabled for TypeScript by
typescript-eslint's `eslint-recommended`, so nothing errors — but the
rules that catch a missing dependency array are silently not running.
The fix is one line, `"apps/marketing-next/**/*.{ts,tsx}",` added to that
array, and it is left to whoever owns that file.
