/**
 * Next.js config for the marketing pilot (roadmap §38–40).
 *
 * Everything here that is not a Next default exists because of the
 * monorepo, and each one is a cost the eventual `apps/web` migration
 * pays too. They are documented individually rather than compressed,
 * because this file IS the deliverable of the pilot.
 */

import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * COST #0 — the build output directory has to be renamed.
   *
   * Next defaults to `.next/`. Nothing in this repo ignores that name:
   * the root `.gitignore` has `dist/`, and `eslint.config.mjs` ignores
   * recursive globs over `dist` and `build`. Leaving the default meant
   * `npx eslint .` walked into the emitted server bundle and produced
   * 56 parsing errors — "was not found by the project service" — for
   * generated JavaScript belonging to no tsconfig.
   *
   * Renaming the output is the fix that stays inside this app.
   * The alternative was adding a `.next` glob to the workspace's shared
   * ignore list, which is a change to a file every project depends on
   * in order to accommodate one project's default.
   *
   * It also makes this app agree with the other four: `apps/web`,
   * `apps/platform`, `apps/marketing` and `apps/api` all build to
   * `dist/`.
   */
  distDir: "dist",

  /**
   * COST #1 — transpilePackages.
   *
   * Every `libs/*` package in this workspace points `main` at
   * `src/index.ts`. There is no build step and no emitted JS: the
   * consumer compiles the library's TypeScript itself. Vite does that
   * without being asked, because its dep-optimiser treats workspace
   * links as source.
   *
   * Next does NOT. Its default is to treat anything resolved out of
   * node_modules (which is what a pnpm workspace link is) as
   * already-compiled JS, so the first `import { TIER_FEATURES } from
   * "@loan/licensing/browser"` fails at build with a parse error on the
   * `export type` — webpack hands the .ts file to no loader at all.
   *
   * Naming the packages here puts them through the app's SWC pipeline.
   * The list must be maintained by hand: a library added to the import
   * graph later fails the same way until someone remembers this file.
   * For `apps/web`, which imports eight of these, the list is eight
   * entries plus every transitive workspace dep.
   */
  transpilePackages: ["@loan/licensing", "@loan/shared-types"],

  /**
   * COST #2 — the /public API proxy.
   *
   * The Vite app got this from `server.proxy` in vite.config.ts, which
   * is a DEV-ONLY facility; in production nginx does the same job via
   * deploy/railway/proxy-marketing.inc. Next has no dev-only proxy —
   * `rewrites()` applies in dev and in production alike, which is
   * actually the better arrangement (one rule, both environments) but
   * it does mean the Next server, not nginx, is now on the request path
   * for /public in production unless the rewrite is disabled.
   *
   * Kept env-driven so a deployment that would rather let nginx keep
   * doing it can point MARKETING_API_ORIGIN at nothing and drop the
   * rule. See docs/modernization/nextjs-migration.md.
   */
  async rewrites() {
    const apiOrigin = process.env.MARKETING_API_ORIGIN ?? "http://127.0.0.1:3001";
    return [{ source: "/public/:path*", destination: `${apiOrigin}/public/:path*` }];
  },

  /**
   * COST #3 — CSP has to be re-solved from scratch.
   *
   * apps/web bakes its policy into index.html as a <meta> from
   * vite.config.ts, precisely so the policy survives being served by
   * any of the four deployment paths. A Next app has no index.html to
   * bake into: the HTML is generated per request (or per build, for a
   * static route), so the policy has to be a real response header.
   *
   * That is a strict improvement — a header can carry `frame-ancestors`,
   * which a <meta> cannot, so the split that deploy/railway/
   * nginx.spa.conf.template currently papers over disappears. The
   * policy below is the marketing site's own, and it is much narrower
   * than the console's: no WASM, no OCR CDN, no service worker.
   *
   * `'unsafe-inline'` in style-src is Next's, not ours: the framework
   * injects inline <style> tags for the CSS it code-splits, and in dev
   * it injects inline bootstrap scripts too. Hash-based script-src is
   * therefore not reachable without `nonce` middleware — noted in the
   * report as the single largest CSP regression versus the Vite app,
   * which needs neither keyword for scripts.
   */
  async headers() {
    const dev = process.env.NODE_ENV !== "production";
    const csp = [
      "default-src 'self'",
      `script-src 'self'${dev ? " 'unsafe-eval' 'unsafe-inline'" : " 'unsafe-inline'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      `connect-src 'self'${dev ? " ws: wss:" : ""}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },

  /**
   * COST #4 — output: "standalone".
   *
   * The Vite app builds to a `dist/` of static files that nginx serves,
   * and deploy/railway/Dockerfile.marketing is built around exactly
   * that. A Next app with any dynamic rendering needs a Node process.
   * `standalone` emits a self-contained server bundle so the runtime
   * image does not need the pnpm workspace — without it, `next start`
   * in a slim image cannot resolve the workspace-linked libs.
   *
   * The alternative — `output: "export"` — would keep the existing
   * nginx image byte-for-byte, at the cost of giving up every server
   * capability the migration is supposed to be buying. Discussed in
   * the report.
   */
  output: "standalone",

  /**
   * COST #5 — the standalone tracer has to be pointed at the repo root.
   *
   * It walks up from the app directory looking for a lockfile to decide
   * what to copy into `.next/standalone`. In a pnpm workspace the
   * packages it needs are symlinks OUT of apps/marketing-next, so
   * without this it traces the wrong root and emits a server bundle
   * missing every `@loan/*` package.
   *
   * Two ways to get this wrong, both of which fail SILENTLY — the build
   * reports success and simply emits no `standalone/` directory at all.
   * Both were hit while writing this file:
   *
   *   1. The key lives under `experimental` in Next 14 and graduated to
   *      the top level in Next 15. At the top level here you get an
   *      "Unrecognized key(s) in object" warning and nothing else.
   *   2. It must be a real filesystem path. `new URL("../../",
   *      import.meta.url).pathname` yields "/D:/codespaces/..." on
   *      Windows — a leading slash the OS cannot resolve — so the tracer
   *      finds nothing to trace. `fileURLToPath` is the correct
   *      conversion and is what the rest of this repo uses (see
   *      apps/web/vite.config.ts).
   *
   * Neither mistake is discovered until the Docker image is run, which
   * is a long way from where it was made.
   */
  experimental: {
    outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  },
};

export default nextConfig;
