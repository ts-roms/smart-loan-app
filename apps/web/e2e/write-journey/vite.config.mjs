import { mergeConfig } from "vite";

import base from "../../vite.config";

/**
 * Vite config for the WRITE journey's dedicated web server.
 *
 * The main `vite.config.ts` pins its proxy to the dev API on
 * 127.0.0.1:3001 — correct for development and for the read-only E2E
 * suite, and exactly wrong for a journey that writes: pointed there it
 * would drift the shared dev ledger, which is the failure mode
 * `e2e/README.md` exists to prevent.
 *
 * So the write journey runs a SECOND Vite on :5183 whose only
 * difference is the proxy target: the scratch-stack API on :3003,
 * which `run.mjs` boots against a disposable database. Everything else
 * — plugins, CSP, aliases — is inherited from the real config, so the
 * journey exercises the same app the dev server serves.
 *
 * Ports are constants shared with `run.mjs`; override via
 * E2E_WRITE_API_PORT / E2E_WRITE_WEB_PORT if 3003/5183 are taken.
 *
 * `.mjs`, not `.ts`, and that is load-bearing: `apps/web/tsconfig.json`
 * includes `e2e/**\/*.ts`, so a TypeScript file here would drag the base
 * `vite.config.ts` — which the tsconfig deliberately does NOT include —
 * into the typecheck program through this import, and `pnpm typecheck`
 * would start failing on three pre-existing strictness complaints in a
 * file this task never touched. Vite bundles its config with esbuild
 * either way, so the `.ts` import below still resolves at runtime.
 */
const API = `http://127.0.0.1:${process.env.E2E_WRITE_API_PORT ?? "3003"}`;

export default mergeConfig(base, {
  server: {
    port: Number(process.env.E2E_WRITE_WEB_PORT ?? "5183"),
    // A silent fallback port would strand Playwright's baseURL on a
    // server that isn't there. Refusing loudly is the better failure.
    strictPort: true,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/uploads": { target: API, changeOrigin: true },
    },
  },
});
