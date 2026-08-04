import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { themeColors } from "./src/theme";

/**
 * Injects theme palette values from `src/theme.ts` into `index.html`
 * at build time so the static HTML head is never out of sync with the
 * runtime palette. Replaces tokens like `%THEME_COLOR_BG%`.
 *
 * Tokens are intentionally NOT Vite's built-in `%ENV_VAR%` syntax —
 * those need an env var, and we want compile-time constants. Plain
 * string replace covers it.
 */
/*
 * Rewrites the root-absolute asset links in index.html to sit under the
 * configured base.
 *
 * Vite rewrites `src="/src/main.tsx"` for us but leaves hand-written
 * `href="/favicon.svg"` alone. Mounted at /app behind the marketing
 * host, those resolve against the ROOT — i.e. the marketing service —
 * and 404. Same reason the manifest's icon srcs are template strings.
 */
function baseAbsoluteLinks(base: string): Plugin {
  return {
    name: "smartloan-base-absolute-links",
    enforce: "post",
    transformIndexHtml(html) {
      if (base === "/") return html;
      return html
        .replace(/href="\/favicon\.svg"/g, `href="${base}favicon.svg"`)
        .replace(/href="\/icons\//g, `href="${base}icons/`);
    },
  };
}

function injectThemeTokens(): Plugin {
  return {
    name: "smartloan-inject-theme-tokens",
    transformIndexHtml(html) {
      return html
        .replace(/%THEME_COLOR_BG%/g, themeColors.background)
        .replace(/%THEME_COLOR_FG%/g, themeColors.foreground)
        .replace(/%THEME_COLOR_PRIMARY%/g, themeColors.primary);
    },
  };
}

// Resolve `@/*` to apps/web/src/* — matches the path alias in tsconfig.json
// so feature imports look like `from '@/features/loans'` from anywhere.
/*
 * Where this app is mounted, as a build-time constant.
 *
 * Deployed, the tenant app sits under /app on the shared hostname —
 * marketing owns the root. Locally it stays at / so `pnpm dev` and the
 * e2e flows are unchanged.
 *
 * ONE value feeds Vite's `base`, the router's basename (via
 * import.meta.env.BASE_URL) and the PWA's scope/start_url/fallback.
 * They have to agree: a service worker whose scope doesn't match the
 * page it controls silently stops controlling it, and a navigateFallback
 * outside the base serves the wrong document — both failure modes this
 * app has already been bitten by.
 */
const BASE = process.env.APP_BASE_PATH ?? "/";

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    injectThemeTokens(),
    baseAbsoluteLinks(BASE),
    /*
     * PWA — makes SmartLoan installable (desktop icon, standalone
     * window, splash screen). Auto-update strategy: the service worker
     * polls for new builds and prompts the user to refresh.
     *
     * We DELIBERATELY don't cache API responses by default — financial
     * data must always be fresh. The runtimeCaching block below uses a
     * NetworkFirst policy for static assets only, and SKIPS auth +
     * mutation endpoints entirely so a stale SW can't serve a stale
     * JWT or an outdated loan balance.
     *
     * Set `disable: true` here when working on the service worker to
     * stop the registration loop in dev (Vite handles HMR; the SW
     * sometimes fights it). Keep the manifest enabled either way so
     * the installable affordance still renders.
     */
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "robots.txt"],
      manifest: {
        name: "SmartLoan",
        short_name: "SmartLoan",
        description:
          "Advanced loan management for Philippine cooperatives — origination, KYC, decisioning, collections, accounting.",
        // Sourced from src/theme.ts so the PWA manifest, the
        // `<meta name="theme-color">` tag, and the runtime CSS all
        // resolve to the same brand colour.
        theme_color: themeColors.background,
        background_color: themeColors.background,
        display: "standalone",
        orientation: "any",
        // Start at root so the installed app drops the user on the
        // dashboard (or login if not signed in).
        start_url: BASE,
        scope: BASE,
        // Edge / Chrome show the description + screenshots when
        // promoting the install banner. Keeping it lean for now.
        categories: ["finance", "business", "productivity"],
        // Using SVG icons for now: Chrome / Edge / Brave / Firefox accept
        // them; iOS Safari uses the apple-touch-icon link in index.html.
        // To upgrade to raster PNGs (best practice for full Android +
        // iOS install affordance) run `pnpm dlx @vite-pwa/assets-generator`
        // against public/icons/icon.svg — that produces 192/512/maskable
        // PNGs and you swap the entries below to image/png.
        icons: [
          {
            src: `${BASE}icons/icon.svg`,
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: `${BASE}icons/icon-maskable.svg`,
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache everything the build emits, but skip the model files
        // for face-api / OCR — they're large (>2MB each), best fetched
        // lazily on first use, and don't need to be available offline.
        globPatterns: ["**/*.{js,css,html,svg,ico,woff2}"],
        globIgnores: ["models/**", "assets/face-api*"],
        // 5 MB cap per asset — face-api ships a 1.3 MB chunk that
        // would exceed Workbox's default 2 MB ceiling otherwise.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        /*
         * SPA navigation fallback — MUST be the app shell.
         *
         * Workbox serves this for EVERY navigation request the service
         * worker handles, not only ones the network refuses. Pointing it
         * at offline.html meant that once the SW installed, every reload
         * and every deep link rendered "You're offline" — online,
         * offline, didn't matter. Installing the PWA bricked the app.
         *
         * index.html is precached, so it also loads with no network at
         * all; React then boots and can show its own offline state.
         * offline.html stays precached as the pre-install cold-start
         * fallback, but it is deliberately NOT the navigation target.
         */
        navigateFallback: `${BASE}index.html`,
        // Never hand API or upload requests the HTML shell — they must
        // fail as requests so the client's error handling sees them.
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        runtimeCaching: [
          {
            // Static images / fonts from our own origin — cache-first
            // is fine; they're content-addressed.
            urlPattern: /\.(?:png|jpg|jpeg|svg|webp|woff2)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "smartloan-assets",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
              },
            },
          },
          {
            // Read-only GETs to safe-to-cache endpoints — NetworkFirst
            // with a 3-second timeout so users on flaky connections
            // get *something* rather than a spinner. Explicit allowlist
            // (NOT a blanket /api/v1/ rule) so we never accidentally
            // cache auth or write-side endpoints.
            urlPattern: /^\/api\/v1\/(loan-products|help)\b/,
            handler: "NetworkFirst",
            options: {
              cacheName: "smartloan-config",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 }, // 1h
            },
          },
        ],
        // Auto-claim clients so an updated SW takes effect immediately
        // (after the user accepts the update prompt).
        clientsClaim: true,
        skipWaiting: false,
      },
      devOptions: {
        // Easier to test SW behaviour locally — but expect Vite HMR
        // to fight with it sometimes. Turn off if it gets annoying.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/uploads": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
